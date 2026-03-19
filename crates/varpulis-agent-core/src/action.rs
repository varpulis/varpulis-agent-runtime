use crate::pattern::Detection;

/// Dispatches detections to registered callbacks.
pub struct ActionDispatcher {
    callbacks: Vec<Box<dyn Fn(&Detection) + Send>>,
}

impl ActionDispatcher {
    pub fn new() -> Self {
        Self {
            callbacks: Vec::new(),
        }
    }

    /// Register a callback invoked on every (non-cooled-down) detection.
    pub fn on_detection(&mut self, cb: Box<dyn Fn(&Detection) + Send>) {
        self.callbacks.push(cb);
    }

    /// Dispatch a detection to all registered callbacks.
    pub fn dispatch(&self, detection: &Detection) {
        for cb in &self.callbacks {
            cb(detection);
        }
    }
}

impl Default for ActionDispatcher {
    fn default() -> Self {
        Self::new()
    }
}
