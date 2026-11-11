use serde_json::Value;

pub fn panes(value: &Value) -> Vec<(String, String)> {
    let mut found = Vec::new();
    collect(value, "", false, &mut found, 0);
    found.sort_by(|left, right| left.0.cmp(&right.0));
    found.dedup_by(|left, right| left.0 == right.0);
    found
}

fn collect(
    value: &Value,
    group: &str,
    pane_collection: bool,
    found: &mut Vec<(String, String)>,
    depth: usize,
) {
    if depth > 12 || found.len() >= 256 {
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                collect(item, group, pane_collection, found, depth + 1);
            }
        }
        Value::Object(object) => {
            let id = object
                .get("pane_id")
                .or_else(|| {
                    if pane_collection {
                        object.get("id")
                    } else {
                        None
                    }
                })
                .and_then(Value::as_str);
            if let Some(id) = id.filter(|id| !id.is_empty()) {
                let name = object
                    .get("title")
                    .or_else(|| object.get("terminal_title"))
                    .or_else(|| object.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(id);
                found.push((
                    id.into(),
                    if group.is_empty() {
                        name.into()
                    } else {
                        format!("{group} / {name}")
                    },
                ));
            }
            for (key, nested) in object {
                if matches!(key.as_str(), "workspaces" | "tabs") {
                    if let Some(items) = nested.as_array() {
                        for item in items {
                            let label = item
                                .get("label")
                                .or_else(|| item.get("name"))
                                .or_else(|| item.get("id"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let label = if group.is_empty() {
                                label.into()
                            } else {
                                format!("{group} / {label}")
                            };
                            collect(item, &label, false, found, depth + 1);
                        }
                    }
                } else {
                    collect(nested, group, key == "panes", found, depth + 1);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_preserves_workspace_and_tab_labels_without_treating_them_as_panes() {
        let snapshot = json!({"workspaces":[{"id":"workspace","label":"工作区","tabs":[{"id":"tab","label":"服务","panes":[{"id":"pane","title":"Shell"}]}]}],"agents":[{"id":"agent","kind":"agent"}]});
        assert_eq!(
            panes(&snapshot),
            vec![("pane".into(), "工作区 / 服务 / Shell".into())]
        );
    }

    #[test]
    fn flat_contract_panes_are_deduplicated_and_bounded() {
        let snapshot = json!({"panes": (0..300).map(|index|json!({"pane_id":format!("pane-{index}"),"title":"Terminal"})).collect::<Vec<_>>()});
        assert_eq!(panes(&snapshot).len(), 256);
        assert_eq!(
            panes(&json!({"panes":[{"pane_id":"p"},{"pane_id":"p"}]})).len(),
            1
        );
    }
}
