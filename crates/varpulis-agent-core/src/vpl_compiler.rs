//! VPL-to-SasePattern compiler.
//!
//! Parses VPL source (Varpulis Pattern Language) and compiles named `pattern`
//! declarations into `SasePattern` objects that can be fed to `SaseEngine`.
//!
//! This is a lightweight extraction of the compilation logic from
//! `varpulis-runtime`, avoiding the heavy async runtime dependency.

use std::time::Duration;

use varpulis_core::ast::{BinOp, Expr, KleeneOp, SasePatternExpr, SasePatternItem, Stmt, UnaryOp};
use varpulis_core::Value;
use varpulis_sase::{CompareOp, Predicate, SasePattern};

/// A named pattern compiled from VPL source.
pub struct CompiledPattern {
    pub name: String,
    pub pattern: SasePattern,
}

/// Parse VPL source and compile all `pattern` declarations into SasePatterns.
pub fn compile_vpl(source: &str) -> Result<Vec<CompiledPattern>, String> {
    let program = varpulis_parser::parse(source).map_err(|e| format!("VPL parse error: {e}"))?;

    let mut patterns = Vec::new();

    for spanned_stmt in &program.statements {
        if let Stmt::PatternDecl {
            name,
            expr,
            within,
            ..
        } = &spanned_stmt.node
        {
            let within_dur = within.as_ref().and_then(expr_to_duration);
            let sase = compile_pattern_expr(expr, within_dur)
                .ok_or_else(|| format!("Failed to compile pattern '{name}'"))?;
            patterns.push(CompiledPattern {
                name: name.clone(),
                pattern: sase,
            });
        }
    }

    if patterns.is_empty() {
        return Err("No pattern declarations found in VPL source".to_string());
    }

    Ok(patterns)
}

/// Compile a `SasePatternExpr` into a runtime `SasePattern`.
fn compile_pattern_expr(
    expr: &SasePatternExpr,
    within: Option<Duration>,
) -> Option<SasePattern> {
    let pattern = match expr {
        SasePatternExpr::Seq(items) => {
            let steps: Vec<SasePattern> = items.iter().map(compile_pattern_item).collect();
            if steps.len() == 1 {
                steps.into_iter().next().unwrap()
            } else {
                SasePattern::Seq(steps)
            }
        }
        SasePatternExpr::And(left, right) => {
            let l = compile_pattern_expr(left, None)?;
            let r = compile_pattern_expr(right, None)?;
            SasePattern::And(Box::new(l), Box::new(r))
        }
        SasePatternExpr::Or(left, right) => {
            let l = compile_pattern_expr(left, None)?;
            let r = compile_pattern_expr(right, None)?;
            SasePattern::Or(Box::new(l), Box::new(r))
        }
        SasePatternExpr::Not(inner) => {
            let i = compile_pattern_expr(inner, None)?;
            SasePattern::Not(Box::new(i))
        }
        SasePatternExpr::Event(name) => SasePattern::Event {
            event_type: name.clone(),
            predicate: None,
            alias: None,
        },
        SasePatternExpr::Group(inner) => {
            return compile_pattern_expr(inner, within);
        }
    };

    if let Some(duration) = within {
        Some(SasePattern::Within(Box::new(pattern), duration))
    } else {
        Some(pattern)
    }
}

/// Compile a single `SasePatternItem` to a `SasePattern`, handling Kleene operators.
fn compile_pattern_item(item: &SasePatternItem) -> SasePattern {
    let predicate = item.filter.as_ref().and_then(expr_to_predicate);
    let base = SasePattern::Event {
        event_type: item.event_type.clone(),
        predicate,
        alias: item.alias.clone(),
    };

    match &item.kleene {
        Some(KleeneOp::Plus) => SasePattern::KleenePlus(Box::new(base)),
        Some(KleeneOp::Star) => SasePattern::KleeneStar(Box::new(base)),
        Some(KleeneOp::Optional) => SasePattern::KleeneStar(Box::new(base)),
        None => base,
    }
}

/// Convert an AST expression to a SASE predicate.
fn expr_to_predicate(expr: &Expr) -> Option<Predicate> {
    match expr {
        Expr::Binary { op, left, right } => {
            let compare_op = match op {
                BinOp::Eq => Some(CompareOp::Eq),
                BinOp::NotEq => Some(CompareOp::NotEq),
                BinOp::Lt => Some(CompareOp::Lt),
                BinOp::Le => Some(CompareOp::Le),
                BinOp::Gt => Some(CompareOp::Gt),
                BinOp::Ge => Some(CompareOp::Ge),
                BinOp::And => {
                    let l = expr_to_predicate(left)?;
                    let r = expr_to_predicate(right)?;
                    return Some(Predicate::And(Box::new(l), Box::new(r)));
                }
                BinOp::Or => {
                    let l = expr_to_predicate(left)?;
                    let r = expr_to_predicate(right)?;
                    return Some(Predicate::Or(Box::new(l), Box::new(r)));
                }
                _ => None,
            }?;

            // Cross-event reference: field == alias.field
            if let (Expr::Ident(field), Expr::Member { expr: ref_expr, member: ref_field }) =
                (left.as_ref(), right.as_ref())
            {
                if let Expr::Ident(ref_alias) = ref_expr.as_ref() {
                    return Some(Predicate::CompareRef {
                        field: field.clone(),
                        op: compare_op,
                        ref_alias: ref_alias.clone(),
                        ref_field: ref_field.clone(),
                    });
                }
            }

            // Simple field comparison: field op value
            let field = match left.as_ref() {
                Expr::Ident(name) => name.clone(),
                _ => return Some(Predicate::Expr(Box::new(expr.clone()))),
            };

            if let Some(value) = expr_to_value(right) {
                Some(Predicate::Compare {
                    field,
                    op: compare_op,
                    value,
                })
            } else {
                Some(Predicate::Expr(Box::new(expr.clone())))
            }
        }
        Expr::Unary {
            op: UnaryOp::Not,
            expr: inner,
        } => {
            let inner_pred = expr_to_predicate(inner)?;
            Some(Predicate::Not(Box::new(inner_pred)))
        }
        _ => Some(Predicate::Expr(Box::new(expr.clone()))),
    }
}

/// Convert an AST expression to a Value (for constant comparisons).
fn expr_to_value(expr: &Expr) -> Option<Value> {
    match expr {
        Expr::Int(n) => Some(Value::Int(*n)),
        Expr::Float(f) => Some(Value::Float(*f)),
        Expr::Str(s) => Some(Value::from(s.as_str())),
        Expr::Bool(b) => Some(Value::Bool(*b)),
        _ => None,
    }
}

/// Convert a duration expression (e.g., `10s`, `5m`) to a `Duration`.
fn expr_to_duration(expr: &Expr) -> Option<Duration> {
    match expr {
        Expr::Duration(ms) => Some(Duration::from_millis(*ms as u64)),
        Expr::Int(n) => Some(Duration::from_secs(*n as u64)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compile_retry_storm_vpl() {
        let source = include_str!("../../../patterns/retry_storm.vpl");
        let patterns = compile_vpl(source).expect("Failed to compile retry_storm.vpl");
        assert_eq!(patterns.len(), 1);
        assert_eq!(patterns[0].name, "RetryStorm");
    }

    #[test]
    fn compile_error_spiral_vpl() {
        let source = include_str!("../../../patterns/error_spiral.vpl");
        let patterns = compile_vpl(source).expect("Failed to compile error_spiral.vpl");
        assert_eq!(patterns.len(), 1);
        assert_eq!(patterns[0].name, "ErrorSpiral");
    }

    #[test]
    fn compile_circular_reasoning_vpl() {
        let source = include_str!("../../../patterns/circular_reasoning.vpl");
        let patterns = compile_vpl(source).expect("Failed to compile circular_reasoning.vpl");
        assert_eq!(patterns.len(), 1);
        assert_eq!(patterns[0].name, "CircularReasoning");
    }

    #[test]
    fn compile_all_builtin_patterns() {
        let files = [
            include_str!("../../../patterns/retry_storm.vpl"),
            include_str!("../../../patterns/error_spiral.vpl"),
            include_str!("../../../patterns/budget_runaway.vpl"),
            include_str!("../../../patterns/stuck_agent.vpl"),
            include_str!("../../../patterns/circular_reasoning.vpl"),
        ];
        for (i, source) in files.iter().enumerate() {
            let patterns = compile_vpl(source).unwrap_or_else(|e| panic!("Pattern {i} failed: {e}"));
            assert_eq!(patterns.len(), 1, "Pattern {i} should produce exactly 1 pattern");
        }
    }

    #[test]
    fn compile_custom_vpl() {
        let source = r#"
            pattern CustomDrift = SEQ(
                ToolCall as first,
                ToolCall+ where name != first.name as drift
            ) within 60s
        "#;
        let patterns = compile_vpl(source).expect("Failed to compile custom VPL");
        assert_eq!(patterns[0].name, "CustomDrift");
    }
}
