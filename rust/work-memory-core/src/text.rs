use unicode_casefold::UnicodeCaseFold;

/// Apply the Unicode case-folding operation used by memory search and tag
/// identity rules.
pub fn unicode_case_fold(value: &str) -> String {
    value.case_fold().collect()
}
