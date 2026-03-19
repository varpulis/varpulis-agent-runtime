use std::collections::HashMap;

/// Prevents the same pattern from firing repeatedly in quick succession.
pub struct CooldownManager {
    /// pattern_name → timestamp_ms of last fire.
    last_fired: HashMap<String, u64>,
    /// Minimum milliseconds between firings of the same pattern.
    cooldown_ms: u64,
}

impl CooldownManager {
    pub fn new(cooldown_ms: u64) -> Self {
        Self {
            last_fired: HashMap::new(),
            cooldown_ms,
        }
    }

    /// Returns `true` if the pattern is allowed to fire (not in cooldown).
    /// If allowed, records the current timestamp.
    pub fn try_fire(&mut self, pattern_name: &str, timestamp_ms: u64) -> bool {
        if let Some(&last) = self.last_fired.get(pattern_name) {
            if timestamp_ms.saturating_sub(last) < self.cooldown_ms {
                return false;
            }
        }
        self.last_fired
            .insert(pattern_name.to_string(), timestamp_ms);
        true
    }

    pub fn reset(&mut self) {
        self.last_fired.clear();
    }
}

impl Default for CooldownManager {
    fn default() -> Self {
        Self::new(30_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_first_fire() {
        let mut cm = CooldownManager::new(5000);
        assert!(cm.try_fire("test", 1000));
    }

    #[test]
    fn blocks_during_cooldown() {
        let mut cm = CooldownManager::new(5000);
        assert!(cm.try_fire("test", 1000));
        assert!(!cm.try_fire("test", 3000));
    }

    #[test]
    fn allows_after_cooldown() {
        let mut cm = CooldownManager::new(5000);
        assert!(cm.try_fire("test", 1000));
        assert!(!cm.try_fire("test", 3000));
        assert!(cm.try_fire("test", 7000));
    }

    #[test]
    fn independent_per_pattern() {
        let mut cm = CooldownManager::new(5000);
        assert!(cm.try_fire("a", 1000));
        assert!(cm.try_fire("b", 1000));
        assert!(!cm.try_fire("a", 2000));
        assert!(!cm.try_fire("b", 2000));
    }

    #[test]
    fn reset_clears_cooldowns() {
        let mut cm = CooldownManager::new(5000);
        cm.try_fire("test", 1000);
        cm.reset();
        assert!(cm.try_fire("test", 2000));
    }
}
