//! Differential-testing oracle: read one input per line, print `1` when the
//! low-information gate downgrades an automatic append, `0` otherwise.
//! Temporary migration tool; delete with the Rust workspace.
use std::io::{self, BufRead};

use doggie_domain::{
    BucketType, ClassificationAction, ClassificationResult, apply_low_information_reference_gate,
};

fn main() {
    for line in io::stdin().lock().lines() {
        let text = line.expect("stdin line");
        let result = ClassificationResult::append_existing(
            "bucket-1",
            Some(BucketType::Incident),
            0.95,
            "reason",
            vec![],
        )
        .expect("fixture");
        let gated = apply_low_information_reference_gate(&text, result).expect("gate");
        println!(
            "{}",
            u8::from(gated.action() == ClassificationAction::AskUser)
        );
    }
}
