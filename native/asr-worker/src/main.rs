//! One session-owned Parakeet TDT model, one bounded PCM16 request at a time.
//!
//! stdin: little-endian u32 sample count, followed by that many i16 samples.
//! stdout: one JSON line for readiness, then one JSON line per request.
//! EOF releases the model. The parent kills this process to cancel native
//! inference; there are no threads accepting more requests or replaying audio.

use parakeet_rs::{ParakeetTDT, Transcriber};
use serde_json::{json, Value};
use std::io::{self, Read, Write};

const MAX_SAMPLES: usize = 16_000 * 31;

/// Bound the allocation before reading audio, and distinguish clean EOF from a
/// truncated message. No filenames, audio, transcripts or library errors escape
/// through diagnostics.
fn read_samples(input: &mut impl Read) -> Result<Option<Vec<f32>>, &'static str> {
    let mut header = [0_u8; 4];
    match input.read(&mut header[..1]) {
        Ok(0) => return Ok(None),
        Ok(_) => (),
        Err(_) => return Err("input"),
    }
    input.read_exact(&mut header[1..]).map_err(|_| "input")?;

    let count = u32::from_le_bytes(header) as usize;
    if count == 0 || count > MAX_SAMPLES {
        return Err("input");
    }

    let mut pcm = vec![0_u8; count * 2];
    input.read_exact(&mut pcm).map_err(|_| "input")?;
    let samples = pcm
        .chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0)
        .collect();
    pcm.fill(0);

    Ok(Some(samples))
}

fn send(output: &mut impl Write, message: Value) -> Result<(), &'static str> {
    serde_json::to_writer(&mut *output, &message).map_err(|_| "output")?;
    output.write_all(b"\n").map_err(|_| "output")?;
    output.flush().map_err(|_| "output")
}

fn run(model_dir: &std::ffi::OsStr, output: &mut impl Write) -> Result<(), &'static str> {
    // None selects parakeet-rs's CPU defaults (4 intra / 1 inter thread), just
    // like the installed CPU Voxtype. Model filenames/precision are untouched.
    let mut model =
        ParakeetTDT::from_pretrained(std::path::Path::new(model_dir), None).map_err(|_| "model")?;
    send(
        output,
        json!({"type": "ready", "protocol": 1, "engine": "parakeet-tdt", "decoder": "parakeet-rs/0.3.5"}),
    )?;

    let mut input = io::stdin().lock();
    while let Some(samples) = read_samples(&mut input)? {
        // The library owns this utterance's buffer until inference returns. Only
        // the model survives the iteration; nothing is written to disk.
        let result = model
            .transcribe_samples(samples, 16_000, 1, None)
            .map_err(|_| "inference")?;
        let text = result.text.trim();
        if text.encode_utf16().count() > 4000 {
            return Err("transcript_limit");
        }
        send(output, json!({"type": "result", "text": text}))?;
    }

    Ok(())
}

fn main() {
    // A panic may originate in native/library code; do not forward its payload.
    std::panic::set_hook(Box::new(|_| eprintln!("ASR worker failed")));
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() == 1 && arguments[0] == "--version" {
        println!("companion-asr-worker 0.1.0 (protocol 1, parakeet-rs 0.3.5)");
        return;
    }
    if arguments.len() != 2 || arguments[0] != "--model" {
        eprintln!("Usage: companion-asr-worker --model DIRECTORY");
        std::process::exit(2);
    }

    let mut output = io::stdout().lock();
    if let Err(code) = run(&arguments[1], &mut output) {
        let _ = send(&mut output, json!({"type": "error", "code": code}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_pcm_and_clean_eof() {
        let mut bytes = Vec::from(3_u32.to_le_bytes());
        for sample in [i16::MIN, 0, i16::MAX] {
            bytes.extend(sample.to_le_bytes());
        }
        let mut input = bytes.as_slice();
        assert_eq!(
            read_samples(&mut input).unwrap().unwrap(),
            vec![-1.0, 0.0, 32767.0 / 32768.0]
        );
        assert!(read_samples(&mut input).unwrap().is_none());
    }

    #[test]
    fn rejects_empty_oversized_and_truncated_requests() {
        for bytes in [
            vec![1],
            Vec::from(0_u32.to_le_bytes()),
            Vec::from((MAX_SAMPLES as u32 + 1).to_le_bytes()),
            Vec::from(1_u32.to_le_bytes()),
        ] {
            assert_eq!(read_samples(&mut bytes.as_slice()), Err("input"));
        }
    }
}
