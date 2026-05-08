#!/usr/bin/env python3
"""
Orayan trade-journal audit.

Usage:
  python3 orayan_log_audit.py /mnt/data/orayan_v35_journal_2026-05-08_1778223676334.csv /mnt/data/orayan_audit_outputs

This script uses only the Python standard library. It recalculates trade accuracy using
first-terminal-result logic and exports audit CSVs + a markdown report.
"""
from __future__ import annotations

import csv
import os
import sys
import math
from collections import defaultdict, Counter, OrderedDict
from statistics import mean, median
from typing import Dict, List, Optional, Tuple, Any

TERMINAL_STATES = {"WIN", "LOSS"}
NON_TRADE_STATES = {"DETECTED", "ARMED", "INVALID", "EXPIRED"}
ACTIVE_STATES = {"ACTIVE"}


def safe_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        v = float(value)
        if math.isnan(v) or math.isinf(v):
            return None
        return v
    except Exception:
        return None


def pct(value: Optional[float]) -> str:
    if value is None:
        return ""
    return f"{value:.1f}%"


def fmt(value: Optional[float], digits: int = 3) -> str:
    if value is None:
        return ""
    return f"{value:.{digits}f}"


def load_rows(path: str) -> Tuple[List[Dict[str, str]], List[str]]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = []
        for row in reader:
            # Keep original values as strings for faithful exports.
            row["_ts_int"] = int(row.get("ts") or 0) if str(row.get("ts", "")).isdigit() else 0
            rows.append(row)
        return rows, reader.fieldnames or []


def group_by_signal(rows: List[Dict[str, str]]) -> OrderedDict[str, List[Dict[str, str]]]:
    grouped: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for row in rows:
        grouped[row.get("signalId", "")] .append(row)
    ordered = OrderedDict()
    for sig, rs in sorted(grouped.items(), key=lambda kv: min(r.get("_ts_int", 0) for r in kv[1])):
        ordered[sig] = sorted(rs, key=lambda r: r.get("_ts_int", 0))
    return ordered


def prefix_for(signal_id: str) -> str:
    if signal_id.startswith("v4_"):
        return "v4"
    if signal_id.startswith("paper_"):
        return "paper"
    if signal_id.startswith("sig_"):
        return "sig"
    if signal_id.startswith("be_"):
        return "be"
    return (signal_id.split("_", 1)[0] or "unknown")


def crossed(row: Dict[str, str]) -> Optional[str]:
    side = row.get("side", "")
    price = safe_float(row.get("price"))
    sl = safe_float(row.get("sl"))
    tp = safe_float(row.get("tp1"))
    if side not in ("BUY", "SELL") or price is None or sl is None or tp is None:
        return None
    if side == "BUY":
        if price <= sl:
            return "SL"
        if price >= tp:
            return "TP"
    else:
        if price >= sl:
            return "SL"
        if price <= tp:
            return "TP"
    return None


def build_signal_records(grouped: OrderedDict[str, List[Dict[str, str]]]) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    for signal_id, rs in grouped.items():
        first = rs[0]
        last = rs[-1]
        terms = [r for r in rs if r.get("state") in TERMINAL_STATES]
        first_term = terms[0] if terms else None
        last_term = terms[-1] if terms else None
        active_rows = [r for r in rs if r.get("state") == "ACTIVE"]
        armed_rows = [r for r in rs if r.get("state") == "ARMED"]
        detected_rows = [r for r in rs if r.get("state") == "DETECTED"]
        expired_rows = [r for r in rs if r.get("state") == "EXPIRED"]
        invalid_rows = [r for r in rs if r.get("state") == "INVALID"]

        first_lifecycle = active_rows[0] if active_rows else (armed_rows[0] if armed_rows else (detected_rows[0] if detected_rows else first))
        term_anchor = first_term if first_term else last

        terminal_rows_after_first = []
        if first_term:
            terminal_ts = first_term.get("_ts_int", 0)
            terminal_rows_after_first = [r for r in rs if r.get("_ts_int", 0) > terminal_ts]

        cross_events = []
        for r in rs:
            hit = crossed(r)
            if hit:
                cross_events.append((r.get("time", ""), hit, r.get("price", ""), r.get("state", "")))

        entry = safe_float(first_lifecycle.get("entry"))
        sl = safe_float(first_lifecycle.get("sl"))
        tp = safe_float(first_lifecycle.get("tp1"))
        sl_dist_calc = None
        tp_dist_calc = None
        if entry and sl is not None:
            sl_dist_calc = abs(sl - entry) / abs(entry) * 100
        if entry and tp is not None:
            tp_dist_calc = abs(tp - entry) / abs(entry) * 100

        rec = {
            "signalId": signal_id,
            "prefix": prefix_for(signal_id),
            "symbol": first_lifecycle.get("symbol", ""),
            "side": first_lifecycle.get("side", ""),
            "sessionFirst": first.get("sessionId", ""),
            "sessionsSeen": "|".join(sorted(set(r.get("sessionId", "") for r in rs))),
            "sessionCount": len(set(r.get("sessionId", "") for r in rs)),
            "firstTime": first.get("time", ""),
            "lastTime": last.get("time", ""),
            "rowCount": len(rs),
            "terminalRowCount": len(terms),
            "stateCounts": ";".join(f"{k}:{v}" for k, v in Counter(r.get("state", "") for r in rs).items()),
            "firstState": first.get("state", ""),
            "lastState": last.get("state", ""),
            "firstTerminalState": first_term.get("state", "") if first_term else "",
            "firstTerminalTime": first_term.get("time", "") if first_term else "",
            "firstTerminalPrice": first_term.get("price", "") if first_term else "",
            "lastTerminalState": last_term.get("state", "") if last_term else "",
            "lastTerminalTime": last_term.get("time", "") if last_term else "",
            "lastTerminalPrice": last_term.get("price", "") if last_term else "",
            "truthState": first_term.get("state", "") if first_term else ("EXPIRED" if expired_rows else ("INVALID" if invalid_rows else last.get("state", ""))),
            "uiLatestTerminalState": last_term.get("state", "") if last_term else "",
            "hasDetected": bool(detected_rows),
            "hasArmed": bool(armed_rows),
            "hasActive": bool(active_rows),
            "hasExpired": bool(expired_rows),
            "hasInvalid": bool(invalid_rows),
            "firstLifecycleState": first_lifecycle.get("state", ""),
            "score": first_lifecycle.get("score", ""),
            "rr": first_lifecycle.get("rr", ""),
            "entry": first_lifecycle.get("entry", ""),
            "sl": first_lifecycle.get("sl", ""),
            "tp1": first_lifecycle.get("tp1", ""),
            "slDistCalcPct": fmt(sl_dist_calc, 3),
            "tpDistCalcPct": fmt(tp_dist_calc, 3),
            "lossPrimaryReason": term_anchor.get("loss_primaryReason", "") if term_anchor else "",
            "lossScoreAtLoss": term_anchor.get("loss_scoreAtLoss", "") if term_anchor else "",
            "lossSlDistPct": term_anchor.get("loss_slDistPct", "") if term_anchor else "",
            "lossPriceMovePct": term_anchor.get("loss_priceMovePct", "") if term_anchor else "",
            "trend5m": term_anchor.get("loss_trend5m", "") if term_anchor else "",
            "trend15m": term_anchor.get("loss_trend15m", "") if term_anchor else "",
            "trend1h": term_anchor.get("loss_trend1h", "") if term_anchor else "",
            "score5m": term_anchor.get("loss_score5m", "") if term_anchor else "",
            "score15m": term_anchor.get("loss_score15m", "") if term_anchor else "",
            "score1h": term_anchor.get("loss_score1h", "") if term_anchor else "",
            "activeSignals": term_anchor.get("loss_activeSignals", "") if term_anchor else "",
            "terminalChanged": bool(first_term and last_term and first_term.get("state") != last_term.get("state")),
            "rowsAfterTerminal": len(terminal_rows_after_first),
            "crossEventsAfterUnresolved": len(cross_events),
            "firstCrossEvent": f"{cross_events[0][0]} {cross_events[0][1]} price={cross_events[0][2]} state={cross_events[0][3]}" if cross_events else "",
        }
        records.append(rec)
    return records


def summarize(records: List[Dict[str, Any]], subset_name: str, subset: List[Dict[str, Any]]) -> Dict[str, Any]:
    wins = sum(1 for r in subset if r["firstTerminalState"] == "WIN")
    losses = sum(1 for r in subset if r["firstTerminalState"] == "LOSS")
    closed = wins + losses
    latest_wins = sum(1 for r in subset if r["uiLatestTerminalState"] == "WIN")
    latest_losses = sum(1 for r in subset if r["uiLatestTerminalState"] == "LOSS")
    latest_closed = latest_wins + latest_losses
    expired = sum(1 for r in subset if r["truthState"] == "EXPIRED")
    invalid = sum(1 for r in subset if r["truthState"] == "INVALID")
    active = sum(1 for r in subset if r["truthState"] == "ACTIVE")
    armed = sum(1 for r in subset if r["truthState"] == "ARMED")
    detected = sum(1 for r in subset if r["truthState"] == "DETECTED")
    unresolved = len(subset) - closed - expired - invalid
    return {
        "subset": subset_name,
        "uniqueSignals": len(subset),
        "firstTerminalWins": wins,
        "firstTerminalLosses": losses,
        "firstTerminalClosed": closed,
        "firstTerminalHitRate": wins / closed * 100 if closed else None,
        "latestTerminalWins": latest_wins,
        "latestTerminalLosses": latest_losses,
        "latestTerminalClosed": latest_closed,
        "latestTerminalHitRate": latest_wins / latest_closed * 100 if latest_closed else None,
        "expired": expired,
        "invalid": invalid,
        "unresolvedNonTerminal": unresolved,
        "active": active,
        "armed": armed,
        "detected": detected,
    }


def diagnosis_for_loss(r: Dict[str, Any]) -> str:
    notes = []
    side = r.get("side", "")
    trend5 = (r.get("trend5m") or "").lower()
    trend15 = (r.get("trend15m") or "").lower()
    trend1h = (r.get("trend1h") or "").lower()
    trends = [trend5, trend15, trend1h]
    score_at_loss = safe_float(r.get("lossScoreAtLoss"))
    rr = safe_float(r.get("rr"))
    sl_dist = safe_float(r.get("lossSlDistPct")) or safe_float(r.get("slDistCalcPct"))
    active = r.get("activeSignals") or ""

    if sl_dist is not None and sl_dist < 0.50:
        notes.append(f"very tight SL {sl_dist:.3f}%")
    elif sl_dist is not None and sl_dist < 0.80:
        notes.append(f"tight SL {sl_dist:.3f}%")

    if rr is not None and rr < 1.80:
        notes.append(f"low RR {rr:.2f}")
    elif rr is not None and rr < 2.00:
        notes.append(f"RR below 2.0 ({rr:.2f})")

    if score_at_loss is not None and score_at_loss <= 10:
        notes.append(f"signal collapsed at loss score={score_at_loss:.0f}")
    elif score_at_loss is not None and score_at_loss < 45:
        notes.append(f"weak score at loss={score_at_loss:.0f}")

    if all(t in ("neutral", "backend", "", "unknown") for t in trends):
        notes.append("no real trend confirmation")
    else:
        if side == "BUY" and "bear" in trends:
            notes.append("BUY had bearish timeframe conflict")
        if side == "SELL" and "bull" in trends:
            notes.append("SELL had bullish timeframe conflict")
        if "bull" in trends and "bear" in trends:
            notes.append("mixed bull/bear trend stack")

    if "RSI79" in active or "RSI80" in active or "RSI81" in active:
        notes.append("overextended RSI signal")
    if side == "SELL" and "DIV🟢" in active:
        notes.append("bullish divergence against SELL")
    if side == "BUY" and "DIV🔴" in active:
        notes.append("bearish divergence against BUY")

    if r.get("firstState") in TERMINAL_STATES:
        notes.append("missing detect/active lifecycle before terminal row")
    if int(r.get("terminalRowCount") or 0) > 1:
        notes.append(f"terminal state repeated {r.get('terminalRowCount')}x")
    if r.get("terminalChanged"):
        notes.append("terminal flip after close")
    return "; ".join(notes) if notes else "SL hit but logged features are not enough to isolate cause"


def write_csv(path: str, rows: List[Dict[str, Any]], fieldnames: List[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fieldnames})


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python3 orayan_log_audit.py INPUT.csv [OUTPUT_DIR]", file=sys.stderr)
        return 2
    input_path = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(input_path), "orayan_audit_outputs")
    os.makedirs(out_dir, exist_ok=True)

    rows, fieldnames = load_rows(input_path)
    grouped = group_by_signal(rows)
    records = build_signal_records(grouped)

    # Session order from row timestamps.
    session_info = OrderedDict()
    for row in sorted(rows, key=lambda r: r.get("_ts_int", 0)):
        sid = row.get("sessionId", "")
        if sid not in session_info:
            session_info[sid] = {"sessionId": sid, "rowCount": 0, "firstTs": row.get("_ts_int", 0), "lastTs": row.get("_ts_int", 0), "firstTime": row.get("time", ""), "lastTime": row.get("time", "")}
        info = session_info[sid]
        info["rowCount"] += 1
        if row.get("_ts_int", 0) < info["firstTs"]:
            info["firstTs"] = row.get("_ts_int", 0); info["firstTime"] = row.get("time", "")
        if row.get("_ts_int", 0) > info["lastTs"]:
            info["lastTs"] = row.get("_ts_int", 0); info["lastTime"] = row.get("time", "")

    latest_sid = max(session_info.values(), key=lambda x: x["lastTs"])["sessionId"] if session_info else ""
    latest_records = [r for r in records if r["sessionFirst"] == latest_sid]
    v4_records = [r for r in records if r["prefix"] == "v4"]

    all_summary = summarize(records, "all signals in uploaded CSV", records)
    v4_summary = summarize(records, "all v4 signals in uploaded CSV", v4_records)
    latest_summary = summarize(records, f"latest session {latest_sid}", latest_records)
    summary_rows = [all_summary, v4_summary, latest_summary]
    for prefix in sorted(set(r["prefix"] for r in records)):
        subset = [r for r in records if r["prefix"] == prefix]
        summary_rows.append(summarize(records, f"prefix={prefix}", subset))

    # Session summary based on first occurrence of each signal.
    session_rows = []
    for sid, info in session_info.items():
        subset = [r for r in records if r["sessionFirst"] == sid]
        s = summarize(records, sid, subset)
        session_rows.append({
            "sessionId": sid,
            "firstTime": info["firstTime"],
            "lastTime": info["lastTime"],
            "eventRows": info["rowCount"],
            **{k: v for k, v in s.items() if k != "subset"},
        })

    # Latest session loss review.
    loss_review = []
    for r in latest_records:
        if r["firstTerminalState"] == "LOSS":
            rr = dict(r)
            rr["diagnosis"] = diagnosis_for_loss(r)
            loss_review.append(rr)
    loss_review.sort(key=lambda r: r.get("firstTerminalTime", ""))

    anomalies = []
    for r in records:
        if r.get("terminalChanged"):
            anomalies.append({"severity": "CRITICAL", "type": "terminal_result_changed", "signalId": r["signalId"], "symbol": r["symbol"], "detail": f"First terminal {r['firstTerminalState']} at {r['firstTerminalTime']} then latest terminal {r['lastTerminalState']} at {r['lastTerminalTime']}."})
        if int(r.get("terminalRowCount") or 0) > 1:
            anomalies.append({"severity": "HIGH", "type": "terminal_state_repeated", "signalId": r["signalId"], "symbol": r["symbol"], "detail": f"{r['terminalRowCount']} terminal rows; stateCounts={r['stateCounts']}."})
        if r.get("rowsAfterTerminal") and int(r.get("rowsAfterTerminal") or 0) > 0:
            anomalies.append({"severity": "HIGH", "type": "updates_after_terminal", "signalId": r["signalId"], "symbol": r["symbol"], "detail": f"{r['rowsAfterTerminal']} rows were logged after first terminal result."})
        if r.get("firstState") in TERMINAL_STATES and r.get("prefix") == "v4":
            anomalies.append({"severity": "HIGH", "type": "missing_lifecycle_before_terminal", "signalId": r["signalId"], "symbol": r["symbol"], "detail": f"First observed row is {r['firstState']} at {r['firstTime']}; no DETECTED/ARMED/ACTIVE row in export for this signal."})
        if r.get("sessionCount", 0) > 1:
            anomalies.append({"severity": "MEDIUM", "type": "same_signal_spans_sessions", "signalId": r["signalId"], "symbol": r["symbol"], "detail": f"Signal appears in {r['sessionCount']} sessions: {r['sessionsSeen']}."})
        if r.get("truthState") in ("EXPIRED", "ARMED", "ACTIVE", "DETECTED") and r.get("firstCrossEvent"):
            anomalies.append({"severity": "CRITICAL", "type": "unresolved_state_crossed_target_or_stop", "signalId": r["signalId"], "symbol": r["symbol"], "detail": f"Non-terminal state={r['truthState']} but price crossed {r['firstCrossEvent']} ({r['crossEventsAfterUnresolved']} crossing rows)."})

    signal_fields = [
        "signalId","prefix","symbol","side","sessionFirst","sessionsSeen","sessionCount","firstTime","lastTime","rowCount","terminalRowCount","stateCounts",
        "firstState","lastState","firstTerminalState","firstTerminalTime","firstTerminalPrice","lastTerminalState","lastTerminalTime","lastTerminalPrice","truthState","uiLatestTerminalState",
        "hasDetected","hasArmed","hasActive","hasExpired","hasInvalid","firstLifecycleState","score","rr","entry","sl","tp1","slDistCalcPct","tpDistCalcPct",
        "lossPrimaryReason","lossScoreAtLoss","lossSlDistPct","lossPriceMovePct","trend5m","trend15m","trend1h","score5m","score15m","score1h","activeSignals",
        "terminalChanged","rowsAfterTerminal","crossEventsAfterUnresolved","firstCrossEvent"
    ]
    summary_fields = ["subset","uniqueSignals","firstTerminalWins","firstTerminalLosses","firstTerminalClosed","firstTerminalHitRate","latestTerminalWins","latestTerminalLosses","latestTerminalClosed","latestTerminalHitRate","expired","invalid","unresolvedNonTerminal","active","armed","detected"]
    session_fields = ["sessionId","firstTime","lastTime","eventRows","uniqueSignals","firstTerminalWins","firstTerminalLosses","firstTerminalClosed","firstTerminalHitRate","latestTerminalWins","latestTerminalLosses","latestTerminalClosed","latestTerminalHitRate","expired","invalid","unresolvedNonTerminal","active","armed","detected"]
    loss_fields = ["firstTerminalTime","symbol","side","score","rr","entry","sl","tp1","firstTerminalPrice","lossSlDistPct","lossPriceMovePct","lossScoreAtLoss","trend5m","trend15m","trend1h","score5m","score15m","score1h","activeSignals","diagnosis","signalId"]
    anomaly_fields = ["severity","type","signalId","symbol","detail"]

    write_csv(os.path.join(out_dir, "signal_truth_table.csv"), records, signal_fields)
    write_csv(os.path.join(out_dir, "summary_by_scope.csv"), summary_rows, summary_fields)
    write_csv(os.path.join(out_dir, "session_summary.csv"), session_rows, session_fields)
    write_csv(os.path.join(out_dir, "latest_session_loss_review.csv"), loss_review, loss_fields)
    write_csv(os.path.join(out_dir, "anomalies.csv"), anomalies, anomaly_fields)

    # Markdown report.
    def summary_line(s: Dict[str, Any]) -> str:
        return (f"{s['subset']}: {s['uniqueSignals']} unique; "
                f"first-terminal {s['firstTerminalWins']}W/{s['firstTerminalLosses']}L "
                f"({pct(s['firstTerminalHitRate'])}); latest-terminal {s['latestTerminalWins']}W/{s['latestTerminalLosses']}L "
                f"({pct(s['latestTerminalHitRate'])}); expired={s['expired']}; unresolved={s['unresolvedNonTerminal']}.")

    # Top anomalies sample.
    severe = [a for a in anomalies if a["severity"] == "CRITICAL"]
    repeated = [a for a in anomalies if a["type"] == "terminal_state_repeated"]

    report_path = os.path.join(out_dir, "orayan_v4_audit_report.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("# Orayan v4 Trade Log Audit\n\n")
        f.write(f"Input CSV: `{os.path.basename(input_path)}`\n\n")
        if rows:
            f.write(f"Rows loaded: **{len(rows)}**. First row: **{rows[0].get('time','')}** `{rows[0].get('symbol','')}` `{rows[0].get('state','')}`. Last row: **{rows[-1].get('time','')}** `{rows[-1].get('symbol','')}` `{rows[-1].get('state','')}`.\n\n")
        if len(rows) == 1000:
            f.write("> ⚠️ The export contains exactly **1000 rows**, so it is likely capped or rolling. Do not assume this CSV contains the full deployment history.\n\n")
        f.write("## Recalculated Accuracy\n\n")
        for s in (latest_summary, v4_summary, all_summary):
            f.write(f"- {summary_line(s)}\n")
        f.write("\n")
        f.write("## Critical Calculation Findings\n\n")
        f.write("1. **First-terminal result must be the source of truth.** ORCAUSDT first hit SL, then later logged WIN. Counting the later WIN inflates the hit rate.\n")
        f.write("2. **Terminal state is not locked.** Several signals keep logging WIN/LOSS/EXPIRED rows after they should be closed.\n")
        f.write("3. **Export and UI are not guaranteed to match.** The latest screenshot shows 20 unique, 3W/10L, but this CSV's latest session contains only 13 unique signals and ends at 12:27:25.\n")
        f.write("4. **EXPIRED can be logged while price is beyond TP.** STRKUSDT was exported as EXPIRED even though its price rows were at or above BUY TP1 on 31 rows.\n")
        f.write("5. **Loss diagnostics are too generic.** All v4 losses say 'no clear confluence conflict detected', but the structured columns show trend conflicts, neutral trends, tight stops, low RR, and score collapse.\n\n")
        f.write("## Latest Session Loss Review\n\n")
        f.write("| Time | Pair | Side | Score | RR | SL% | Move% | Score@Loss | Trends | Diagnosis |\n")
        f.write("|---|---:|---:|---:|---:|---:|---:|---:|---|---|\n")
        for r in loss_review:
            trends = "/".join([r.get("trend5m") or "?", r.get("trend15m") or "?", r.get("trend1h") or "?"])
            f.write(f"| {r.get('firstTerminalTime','')} | {r.get('symbol','')} | {r.get('side','')} | {r.get('score','')} | {r.get('rr','')} | {r.get('lossSlDistPct','') or r.get('slDistCalcPct','')} | {r.get('lossPriceMovePct','')} | {r.get('lossScoreAtLoss','')} | {trends} | {r.get('diagnosis','')} |\n")
        f.write("\n")
        f.write("## State Machine Fix Contract\n\n")
        f.write("```text\n")
        f.write("For each signalId:\n")
        f.write("  DETECTED/ARMED may expire before entry. Expired setups are not trades and must not affect hit rate.\n")
        f.write("  ACTIVE means a trade exists. Once ACTIVE, do not convert to EXPIRED.\n")
        f.write("  First WIN or LOSS is terminal and immutable.\n")
        f.write("  If terminalAt exists, ignore all future TP/SL/expiry updates for that signal.\n")
        f.write("  Stats count unique signalId where terminalState is WIN or LOSS.\n")
        f.write("```\n\n")
        f.write("## Filter Plan Before Any Live Use\n\n")
        f.write("- Minimum RR: reject below 1.90 now; target 2.00 once data is stable.\n")
        f.write("- Minimum stop room: reject if SL distance is below 0.50% unless ATR/spread model proves it is enough.\n")
        f.write("- Trend alignment: require at least 2 of 3 timeframes aligned or neutral-supportive; reject BUY with 1h bear; reject SELL with 1h bull.\n")
        f.write("- Score persistence: before ACTIVE, require score to remain above threshold for several ticks/seconds; reject if score collapses.\n")
        f.write("- Conflict penalties: bullish divergence against SELL or bearish divergence against BUY should block the trade, not merely reduce score.\n")
        f.write("- Correlation guard: cap simultaneous same-direction positions during one market regime.\n\n")
        f.write("## Outputs\n\n")
        f.write("- `signal_truth_table.csv`: one row per unique signal, with first-terminal and latest-terminal states.\n")
        f.write("- `latest_session_loss_review.csv`: loss-by-loss diagnosis for latest session.\n")
        f.write("- `anomalies.csv`: state/accounting bugs found in the log.\n")
        f.write("- `session_summary.csv`: deduped session-level accuracy.\n")
        f.write("- `summary_by_scope.csv`: v4/all/prefix summaries.\n")

    print(f"Wrote audit outputs to: {out_dir}")
    print(summary_line(latest_summary))
    print(summary_line(v4_summary))
    print(f"Anomalies: {len(anomalies)} total; critical={len(severe)}; repeated_terminal={len(repeated)}")
    if severe:
        print("Critical examples:")
        for a in severe[:5]:
            print(f"- {a['type']} {a['symbol']} {a['detail']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
