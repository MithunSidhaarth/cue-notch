// Voice: "Hey Cue, pause the music". Windows only.
//
// Everything runs on the device, on Windows' own speech engine with a list of
// phrases: the wake word alone, the wake word followed by a command ("cue
// next song"), and — after the wake word alone — the commands by themselves.
// The page (src/core/intents.ts voicePhrases) hands over that command list;
// a phrase the list doesn't hold is never heard, so nothing else is
// transcribed and nothing is sent anywhere. (Windows' online dictation, the
// only free-form recogniser, ends every turn empty for a desktop app without
// a package identity: it was tried.)
//
// No audio is ever written anywhere, and transcripts are never logged. What
// a command means and what Cue does about it is the page's job
// (src/voice/), which can't approve anything (CLAUDE.md).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use windows::core::HSTRING;
use windows::Foundation::TypedEventHandler;
use windows::Globalization::Language;
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
    SpeechContinuousRecognitionSession,
    SpeechRecognitionConfidence, SpeechRecognitionListConstraint, SpeechRecognitionResultStatus, SpeechRecognizer,
};
use windows_collections::IIterable;

static APP: OnceLock<AppHandle> = OnceLock::new();
static ON: AtomicBool = AtomicBool::new(false);
/// Bumped by every settings or phrase change: an old listener sees it and stops.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static CONFIG: LazyLock<Mutex<Config>> = LazyLock::new(Default::default);
/// The island asked to listen now (its mic button), without the wake word.
static ASK: AtomicBool = AtomicBool::new(false);
/// Cue talks through the ElevenLabs agent: the wake word opens a conversation.
static CONVERSE: AtomicBool = AtomicBool::new(false);
/// A conversation is on: the mic is the page's until it ends.
static TALKING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Default)]
struct Config {
    wake_word: String,
    language: String,
    /// The commands the page understands, lower case.
    commands: Vec<String>,
}

pub(crate) fn emit<S: serde::Serialize + Clone>(event: &str, payload: S) {
    if let Some(app) = APP.get() {
        let _ = app.emit_to(crate::island::WINDOW_LABEL, event, payload);
    }
}

fn word(w: &str) -> String {
    let w = w.trim().to_lowercase();
    // Typed as "Hey Cue": the greeting is added below, so it is not part of the word.
    let w = ["hey ", "ok ", "okay ", "hi "].iter().find_map(|p| w.strip_prefix(p)).unwrap_or(&w).trim().to_string();
    if w.is_empty() { "cue".to_string() } else { w }
}

/// What the recogniser may hear for the wake word. "Cue" is one short sound
/// that dictation spells many ways ("queue", "Q", "kew"…); "Maki" said with an
/// accent, or quickly, comes out as "Mackie" or "Macky". A custom word is taken as is.
pub fn wake_words(wake: &str) -> Vec<String> {
    let w = word(wake);
    let mut all = vec![w.clone()];
    if w == "cue" {
        all.extend(["queue", "q", "kew", "kyu", "que", "cu", "kyoo", "cue's"].map(String::from));
    }
    if w == "maki" {
        all.extend(["mackie", "macky", "maky", "makki", "marky", "mokey"].map(String::from));
    }
    all
}

/// The wake word with its greetings: "cue", "hey cue", "ok cue"… (and its sound-alikes).
pub fn wake_phrases(wake: &str) -> Vec<String> {
    wake_words(wake)
        .iter()
        .flat_map(|w| ["", "hey ", "ok ", "okay ", "hi "].iter().map(move |p| format!("{p}{w}")))
        .collect()
}

/// What the listener waits for: the wake word alone, or with a command.
pub fn wake_grammar(wake: &str, commands: &[String]) -> Vec<String> {
    let w = word(wake);
    let mut all = wake_phrases(wake);
    for c in commands {
        all.push(format!("{w} {c}"));
        all.push(format!("hey {w} {c}"));
    }
    all
}

/// "hey cue next song" → Some("next song"); "cue" → Some(""); else None.
pub fn after_wake(heard: &str, wake: &str) -> Option<String> {
    let h = heard.trim().to_lowercase().replace(',', "");
    let rest = wake_words(wake).iter().find_map(|w| {
        ["hey ", "ok ", "okay ", "hi ", ""].iter().find_map(|p| {
            let r = h.strip_prefix(&format!("{p}{w}"))?;
            // "cue" must not match the start of "cucumber": a word boundary after it.
            (r.is_empty() || r.starts_with(' ')).then_some(r)
        })
    })?;
    Some(rest.trim().to_string())
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

pub fn start(app: &AppHandle, on: bool, wake_word: &str, language: &str) {
    let _ = APP.set(app.clone());
    apply(on, wake_word, language);
}

/// Settings saved: the listener restarts with the new word or language, or stops.
pub fn apply(on: bool, wake_word: &str, language: &str) {
    {
        let mut c = CONFIG.lock().unwrap();
        c.wake_word = wake_word.to_string();
        c.language = language.to_string();
    }
    ON.store(on, Ordering::SeqCst);
    restart();
}

fn restart() {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if !ON.load(Ordering::SeqCst) {
        emit("voice-state", "off");
        return;
    }
    let _ = std::thread::Builder::new().name("cue-voice".into()).spawn(move || {
        let mut told = false;
        while current(generation) {
            match run(generation) {
                Ok(()) => break,
                Err(e) => {
                    // Windows refuses until its speech privacy policy is
                    // accepted (0x80045509): try again now and then.
                    if !told {
                        crate::log::line(format!("voice: {e}"));
                        emit("voice-state", "needs-online");
                        told = true;
                    }
                    for _ in 0..200 {
                        if !current(generation) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        }
    });
}

fn current(generation: u64) -> bool {
    ON.load(Ordering::SeqCst) && GENERATION.load(Ordering::SeqCst) == generation
}

fn recognizer(language: &str, phrases: &[String]) -> windows::core::Result<SpeechRecognizer> {
    let rec = match (!language.is_empty()).then(|| Language::CreateLanguage(&HSTRING::from(language))) {
        Some(Ok(lang)) => SpeechRecognizer::Create(&lang).or_else(|_| SpeechRecognizer::new())?,
        _ => SpeechRecognizer::new()?,
    };
    let list: Vec<HSTRING> = phrases.iter().map(HSTRING::from).collect();
    rec.Constraints()?.Append(&SpeechRecognitionListConstraint::Create(&IIterable::<HSTRING>::from(list))?)?;
    let compiled = rec.CompileConstraintsAsync()?.get()?;
    if compiled.Status()? != SpeechRecognitionResultStatus::Success {
        crate::log::line(format!("voice: grammar didn't compile ({:?})", compiled.Status()?));
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(-1)));
    }
    Ok(rec)
}

fn run(generation: u64) -> windows::core::Result<()> {
    let config = CONFIG.lock().unwrap().clone();
    crate::log::line(format!("voice: listening for the wake word ({} commands)", config.commands.len()));
    emit("voice-state", "waiting");
    while current(generation) {
        let heard = listen(&config, generation)?;
        if heard.is_some() && CONVERSE.load(Ordering::SeqCst) {
            // The page opens the conversation; the listener waits it out.
            TALKING.store(true, Ordering::SeqCst);
            crate::log::line("voice: conversation");
            emit("voice-wake", heard.clone().unwrap_or_default());
            while TALKING.load(Ordering::SeqCst) && current(generation) {
                std::thread::sleep(Duration::from_millis(150));
            }
            continue;
        }
        match heard {
            None => break,
            // The wake word and a command in one breath.
            Some(rest) if !rest.is_empty() => {
                crate::log::line("voice: command heard");
                emit("voice-command", rest);
            }
            // The wake word alone (or the mic button): the command comes next.
            Some(_) => command_turn(&config)?,
        }
    }
    Ok(())
}

/// Waits for the wake word, alone or with a command. None: settings changed.
fn listen(config: &Config, generation: u64) -> windows::core::Result<Option<String>> {
    // With the ElevenLabs agent on, only the wake word matters: a small grammar
    // makes "Hey Cue" far easier to pick out than among 400 command phrases.
    let phrases = if CONVERSE.load(Ordering::SeqCst) {
        wake_phrases(&config.wake_word)
    } else {
        wake_grammar(&config.wake_word, &config.commands)
    };
    let rec = recognizer(&config.language, &phrases)?;
    let heard: Arc<Mutex<Option<String>>> = Arc::default();
    let ended = Arc::new(AtomicBool::new(false));
    let h = heard.clone();
    let wake = config.wake_word.clone();
    let session: SpeechContinuousRecognitionSession = rec.ContinuousRecognitionSession()?;
    session.ResultGenerated(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>::new(
        move |_, args| {
            if let Some(args) = args.as_ref() {
                let r = args.Result()?;
                let conf = r.Confidence()?;
                if r.Status()? == SpeechRecognitionResultStatus::Success && conf != SpeechRecognitionConfidence::Rejected {
                    if let Some(rest) = after_wake(&r.Text()?.to_string(), &wake) {
                        // The wake word alone must be fairly sure (no false wakes from
                        // the TV); with a whole command after it, the phrase is the proof.
                        let raw = r.RawConfidence().unwrap_or(0.0);
                        let greeted = greeted(&r.Text()?.to_string());
                        if wake_is_sure(conf, raw, greeted) || !rest.is_empty() {
                            *h.lock().unwrap() = Some(rest);
                        } else {
                            // Only the confidence: never what was said.
                            crate::log::line(format!("voice: a wake word too unsure to act on ({raw:.2})"));
                        }
                    }
                }
            }
            Ok(())
        },
    ))?;
    // Windows ends a continuous session after a stretch of silence (or when the
    // mic hiccups); a listener that doesn't notice is deaf until Cue restarts.
    let e = ended.clone();
    session.Completed(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionCompletedEventArgs>::new(
        move |_, _| {
            e.store(true, Ordering::SeqCst);
            Ok(())
        },
    ))?;
    // A day of silence before Windows gives up on its own.
    let _ = session.SetAutoStopSilenceTimeout(windows::Foundation::TimeSpan { Duration: 24 * 3600 * 10_000_000 });
    session.StartAsync()?.get()?;
    let out = loop {
        if let Some(rest) = heard.lock().unwrap().take() {
            break Some(rest);
        }
        if ended.swap(false, Ordering::SeqCst) {
            crate::log::line("voice: the listening session ended, starting it again");
            if session.StartAsync().and_then(|a| a.get()).is_err() {
                // The mic is gone (unplugged, taken): a fresh recogniser on the next round.
                std::thread::sleep(Duration::from_millis(500));
                let _ = rec.Close();
                return listen(config, generation);
            }
        }
        if ASK.swap(false, Ordering::SeqCst) {
            break Some(String::new());
        }
        if !current(generation) {
            break None;
        }
        std::thread::sleep(Duration::from_millis(60));
    };
    let _ = session.StopAsync().and_then(|a| a.get());
    // Let go of the microphone before the next recogniser takes it.
    let _ = rec.Close();
    Ok(out)
}

/// After the wake word alone: one command from the list, within a few seconds.
/// The same continuous session as the wake listener: a one-shot RecognizeAsync
/// ends at once with "unknown" on some PCs, the continuous one doesn't.
fn command_turn(config: &Config) -> windows::core::Result<()> {
    emit("voice-state", "listening");
    let rec = recognizer(&config.language, &config.commands)?;
    let heard: Arc<Mutex<Option<String>>> = Arc::default();
    let h = heard.clone();
    let session: SpeechContinuousRecognitionSession = rec.ContinuousRecognitionSession()?;
    session.ResultGenerated(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>::new(
        move |_, args| {
            if let Some(args) = args.as_ref() {
                let r = args.Result()?;
                // Only listed commands can match at all: low confidence is still one of them.
                if r.Status()? == SpeechRecognitionResultStatus::Success && r.Confidence()? != SpeechRecognitionConfidence::Rejected {
                    let text = r.Text()?.to_string();
                    if !text.is_empty() {
                        *h.lock().unwrap() = Some(text);
                    }
                }
            }
            Ok(())
        },
    ))?;
    session.StartAsync()?.get()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(7);
    let got = loop {
        if let Some(text) = heard.lock().unwrap().take() {
            break Some(text);
        }
        if std::time::Instant::now() > deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(60));
    };
    let _ = session.StopAsync().and_then(|a| a.get());
    let _ = rec.Close();
    match got {
        Some(text) => {
            crate::log::line("voice: command heard");
            emit("voice-command", text);
        }
        None => {
            crate::log::line("voice: no command understood");
            emit("voice-command", String::from("?"));
        }
    }
    emit("voice-state", "waiting");
    Ok(())
}

/// The page's commands (lower case): the listener restarts with them.
#[tauri::command]
pub fn voice_set_phrases(phrases: Vec<String>) {
    let mut list: Vec<String> = phrases.into_iter().map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty() && p.len() <= 80).collect();
    list.sort();
    list.dedup();
    list.truncate(1500);
    {
        let mut c = CONFIG.lock().unwrap();
        if c.commands == list {
            return;
        }
        c.commands = list;
    }
    restart();
}

/// The page talks through the ElevenLabs agent (true) or the phrase list (false).
#[tauri::command]
pub fn voice_converse(on: bool) {
    // The grammar depends on it: the listener starts over when it changes.
    if CONVERSE.swap(on, Ordering::SeqCst) != on {
        restart();
    }
}

/// A bare wake word counts when Windows is fairly sure, or its raw score is
/// decent. "Hey Cue" is two words and far harder to hear by accident than a
/// lone "cue", so with a greeting a lower score is enough: short words score low.
pub fn wake_is_sure(conf: SpeechRecognitionConfidence, raw: f64, greeted: bool) -> bool {
    matches!(conf, SpeechRecognitionConfidence::High | SpeechRecognitionConfidence::Medium)
        || raw >= if greeted { 0.25 } else { 0.5 }
}

/// The phrase began with a greeting ("hey", "ok", "hi").
fn greeted(heard: &str) -> bool {
    let h = heard.trim().to_lowercase();
    ["hey ", "ok ", "okay ", "hi "].iter().any(|p| h.starts_with(p))
}

/// The conversation is over: the wake word listener takes the mic back.
#[tauri::command]
pub fn voice_conversation_ended() {
    TALKING.store(false, Ordering::SeqCst);
}

/// The island's mic button: listen for a command now, without the wake word.
#[tauri::command]
pub fn voice_listen_now() -> bool {
    if !ON.load(Ordering::SeqCst) {
        return false;
    }
    ASK.store(true, Ordering::SeqCst);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wake_word_comes_with_its_greetings() {
        assert_eq!(wake_phrases("Maki")[..5], ["maki", "hey maki", "ok maki", "okay maki", "hi maki"]);
        assert!(wake_phrases("Maki").contains(&"hey mackie".to_string()));
        assert_eq!(wake_phrases("Jarvis").len(), 5);
        assert_eq!(wake_phrases(" ")[0], "cue");
    }

    #[test]
    fn a_command_can_ride_with_the_wake_word() {
        let g = wake_grammar("Maki", &["next song".to_string()]);
        assert!(g.contains(&"maki next song".to_string()));
        assert!(g.contains(&"hey maki next song".to_string()));
        assert_eq!(after_wake("Hey Maki next song", "Maki").as_deref(), Some("next song"));
        assert_eq!(after_wake("maki", "Maki").as_deref(), Some(""));
        assert_eq!(after_wake("next song", "Maki"), None);
        assert_eq!(after_wake("Mackie next song", "Maki").as_deref(), Some("next song"));
        assert_eq!(after_wake("makiko", "Maki"), None);
        assert!(wake_is_sure(SpeechRecognitionConfidence::Low, 0.6, false));
        assert!(!wake_is_sure(SpeechRecognitionConfidence::Low, 0.3, false));
        assert!(wake_is_sure(SpeechRecognitionConfidence::Low, 0.3, true), "\"hey cue\" counts on a lower score");
    }

    #[test]
    fn hey_cue_is_heard_however_dictation_spells_it() {
        assert_eq!(wake_phrases(" ")[0], "cue");
        assert_eq!(wake_phrases("Hey Cue")[..2], ["cue", "hey cue"], "typed with its greeting, the greeting is not doubled");
        for heard in ["hey cue", "Hey Queue", "hey Q", "ok kew", "Hey cue, pause the music"] {
            assert!(after_wake(heard, "Cue").is_some(), "{heard}");
        }
        assert_eq!(after_wake("Hey queue next song", "Cue").as_deref(), Some("next song"));
        assert_eq!(after_wake("cucumber", "Cue"), None);
        assert_eq!(after_wake("quick question", "Cue"), None);
        assert!(greeted("Hey cue") && !greeted("cue"));
    }
}
