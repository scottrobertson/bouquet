use std::collections::HashMap;
use std::sync::LazyLock;

use regex::{Captures, Regex};

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{([A-Za-z0-9_]+)\}").unwrap());

// One pass over the template, so a channel or provider name that happens to
// contain a placeholder like "{n}" is left alone.
fn fill(template: &str, values: &HashMap<&str, String>) -> String {
    PLACEHOLDER
        .replace_all(template, |c: &Captures| match values.get(&c[1]) {
            Some(v) => v.clone(),
            None => c[0].to_string(),
        })
        .into_owned()
}

fn provider_values(provider: &str, values: &mut HashMap<&str, String>) {
    let trimmed = crate::js::trim(provider);
    let letter = trimmed.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
    values.insert("provider", trimmed.to_string());
    values.insert("provider_letter", letter);
}

/// A channel's output name from the playlist's channel template. {name} is the
/// channel's own name, {provider} its provider and {provider_letter} the first
/// letter of that.
pub fn channel_name(template: &str, name: &str, provider: &str) -> String {
    let mut values = HashMap::from([("name", name.to_string())]);
    provider_values(provider, &mut values);
    fill(template, &values)
}

/// An alternate's output name from the playlist's alternate template. {name} is
/// the primary's name, {n} the alternate's number starting at 1, and the
/// provider placeholders are the alternate's own provider.
pub fn alt_name(template: &str, name: &str, n: i64, provider: &str) -> String {
    let mut values = HashMap::from([("name", name.to_string()), ("n", n.to_string())]);
    provider_values(provider, &mut values);
    fill(template, &values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alt_name_fills_in_the_name_and_number() {
        assert_eq!(alt_name("{name} (Backup {n})", "BBC One FHD", 1, "Strong8k"), "BBC One FHD (Backup 1)");
        assert_eq!(alt_name("{name} (Alt {n})", "BBC One", 2, "Strong8k"), "BBC One (Alt 2)");
    }

    #[test]
    fn alt_name_replaces_every_occurrence() {
        assert_eq!(alt_name("{name} {name} #{n}", "Sky", 3, "Strong8k"), "Sky Sky #3");
        assert_eq!(alt_name("[{n}] {name}", "ITV", 4, "Strong8k"), "[4] ITV");
    }

    #[test]
    fn alt_name_fills_in_the_provider() {
        assert_eq!(alt_name("{name} ({provider})", "BBC One", 1, "Strong8k"), "BBC One (Strong8k)");
        assert_eq!(alt_name("{name} {provider_letter}{n}", "BBC One", 1, "Strong8k"), "BBC One S1");
        assert_eq!(alt_name("{provider} {provider_letter}", "BBC One", 1, "Strong8k"), "Strong8k S");
    }

    #[test]
    fn provider_letter_is_upper_cased_and_ignores_leading_spaces() {
        assert_eq!(alt_name("{provider_letter}", "x", 1, "  nova tv"), "N");
        assert_eq!(alt_name("{provider_letter}", "x", 1, ""), "");
    }

    #[test]
    fn placeholders_inside_values_are_left_alone() {
        assert_eq!(alt_name("{name} ({provider})", "Test {n}", 2, "{name}"), "Test {n} ({name})");
    }

    #[test]
    fn channel_name_templates() {
        let (name, provider) = ("Sky Sports 1 UHD", "b1g");
        assert_eq!(channel_name("{name}", name, provider), "Sky Sports 1 UHD");
        assert_eq!(channel_name("{name} ({provider_letter})", name, provider), "Sky Sports 1 UHD (B)");
        assert_eq!(channel_name("[{provider}] {name}", name, provider), "[b1g] Sky Sports 1 UHD");
        assert_eq!(channel_name("{name} {n}", name, provider), "Sky Sports 1 UHD {n}");
    }
}
