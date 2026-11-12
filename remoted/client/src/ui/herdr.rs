use serde_json::Value;

pub fn panes(value: &Value) -> Vec<(String, String)> {
    let mut found = Vec::new();
    // Prefer the authoritative snapshot envelope. Other response fields can contain
    // pane references (for example Agent activity) that are not attachable panes.
    let result = value.get("result").unwrap_or(value);
    let snapshot = result.get("snapshot").unwrap_or(result);
    collect(snapshot, "", false, &mut found, 0);
    if let Some(items) = snapshot.get("panes").and_then(Value::as_array) {
        for (id, title) in &mut found {
            let Some(pane) = items.iter().find(|p| pane_id(p) == Some(id.as_str())) else {
                continue;
            };
            let tab = find(snapshot, "tabs", "tab_id", pane.get("tab_id"));
            let workspace = find(
                snapshot,
                "workspaces",
                "workspace_id",
                pane.get("workspace_id")
                    .or_else(|| tab.and_then(|t| t.get("workspace_id"))),
            );
            let groups: Vec<_> = [workspace, tab]
                .into_iter()
                .flatten()
                .filter_map(label)
                .collect();
            if !groups.is_empty() {
                *title = format!("{} / {title}", groups.join(" / "));
            }
            if let Some(agent) = pane
                .get("display_agent")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                *title = format!("{title} · {agent}");
            }
        }
    }
    found.sort_by(|left, right| left.0.cmp(&right.0));
    found.dedup_by(|left, right| left.0 == right.0);
    found
}

fn pane_id(pane: &Value) -> Option<&str> {
    pane.get("pane_id")
        .or_else(|| pane.get("id"))
        .and_then(Value::as_str)
}

fn label(value: &Value) -> Option<&str> {
    ["label", "name", "workspace_id", "tab_id", "id"]
        .into_iter()
        .find_map(|key| {
            value
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
}

fn find<'a>(
    snapshot: &'a Value,
    collection: &str,
    key: &str,
    id: Option<&Value>,
) -> Option<&'a Value> {
    let id = id?.as_str()?;
    snapshot.get(collection)?.as_array()?.iter().find(|item| {
        item.get(key)
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            == Some(id)
    })
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
            let id = if pane_collection {
                pane_id(value)
            } else {
                None
            };
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
    fn real_snapshot_envelope_joins_flat_workspace_and_tab_records() {
        let snapshot = json!({"result":{"snapshot": {
            "workspaces":[{"workspace_id":"w1","label":"项目"}],
            "tabs":[{"tab_id":"t1","workspace_id":"w1","label":"服务"}],
            "panes":[{"pane_id":"p1","tab_id":"t1","title":"Shell","display_agent":"Codex"}],
            "agents":[{"pane_id":"unrelated","name":"Not a pane"}]
        }, "panes":[{"pane_id":"outside"}]}});
        assert_eq!(
            panes(&snapshot),
            vec![("p1".into(), "项目 / 服务 / Shell · Codex".into())]
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
