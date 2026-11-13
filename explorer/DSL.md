# Explorer query language

This is the complete spec for the filter language used by `explorer.html`, and it's meant to be learnable in two minutes. Every weekly-sec challenge that uses the explorer is written so that it can be fully solved with what's on this page.

It is **not** KQL or SPL, and it doesn't pretend to be. The skill it trains is deciding what to filter, what to pivot on and what to count. That transfers to any SIEM.

## Quick reference

```
source = cloudtrail                        exact match
eventName != GetObject                     not equal
userAgent contains "aws-cli"               substring
bytes > 1000000                            comparison: >  <  >=  <=
ts >= 2026-11-10T22:00                     time comparison
eventName in [CreateUser, DeleteUser]      any of a list
errorCode exists                           field present and not empty
"203.0.113"                                quoted text alone: search every field

a and b      a or b      not a      ( a or b ) and c
field not contains x   field not in [x, y]   field not exists

| where count > 1                          filter again, at any point in the pipeline
| sort ts desc, eventName                  sort (asc is the default)
| count by sourceIPAddress, eventName      group and count
| count                                    total
| fields ts, eventName, sourceIPAddress    choose columns
| limit 50                                 first N rows
```

## Structure

```
query  :=  [ condition ]  { "|" stage }
```

A query is an optional condition followed by any number of stages. An empty query returns every event. A query that starts with `|` applies its stages to every event.

## Conditions

### Field paths

Field names are paths into each event. Use dots to reach into nested objects: `userIdentity.arn`, `requestParameters.bucketName`.

If a path passes through an **array**, the condition matches when **any** element matches. For example, `labels = ci` matches an event whose `labels` is `["docs", "ci"]`, and `resources.ARN = x` checks every item in `resources`.

A field that doesn't exist on an event never matches `=`, `contains`, `in` or a comparison. It always matches `!=`.

### Operators

| Operator | Meaning |
|---|---|
| `field = value` | Equal. Text comparison is **case-insensitive**. `==` also works. |
| `field != value` | Not equal (true when the field is missing). |
| `field > value`, `<`, `>=`, `<=` | Ordered comparison (see [Comparison rules](#comparison-rules)). |
| `field contains value` | Case-insensitive substring. On an object or array, it searches the JSON text. |
| `field in [v1, v2, ...]` | Equal to any value in the list. |
| `field exists` | The field is present, not null and not the empty string. |
| `field not contains value` · `field not in [...]` · `field not exists` | Negated forms. |
| `"some text"` | A quoted string on its own searches the **whole event** (all fields, case-insensitive). |

### Values

A value is either:

- **bare**: any run of characters without spaces or the characters `( ) [ ] , | " = ! < >`. For example: `GetObject`, `203.0.113.77`, `arn:aws:iam::111122223333:role/x`, `2026-11-10T23:00`.
- **quoted**: `"..."` with `\"` for a literal quote and `\\` for a backslash. Use quotes for anything with spaces or the characters above, such as `"env | grep"`.

### Comparison rules

When comparing an event's value with your value, the explorer tries these in order:

1. **Time**: if both look like ISO-8601 timestamps, compare them as instants. Your value may be a date (`2026-11-10`), a minute (`2026-11-10T23:51`) or a full timestamp. A time without a zone is treated as **UTC**.
2. **Number**: if both are numbers (or numeric strings, such as `"4120"` and `4120`), compare them numerically.
3. **Text**: otherwise compare as lowercase text.

### Combining

`and` binds tighter than `or`, so `a or b and c` means `a or (b and c)`. Use parentheses when in doubt. `not` applies to the condition directly after it.

Comments: `#` at the start of a token begins a comment that runs to the end of the line. (Inside a quoted value, `#` is just a character.)

## Stages

Stages run left to right, and each one works on the output of the previous one.

| Stage | Effect |
|---|---|
| `\| where <condition>` | Keep only rows matching the condition. Same syntax as above, and it works on aggregated rows too (for example `\| where count > 5`). |
| `\| sort f1 [asc\|desc], f2 [asc\|desc] ...` | Stable sort. Missing values always sort last. Times and numbers sort naturally. |
| `\| count by f1, f2, ...` | Group by the fields and output one row per group, `{f1, f2, count}`, sorted by count (highest first). Later stages see these rows, so you can `\| count by` again. That's how you count distinct values: `\| count by key, ip \| count by key`. |
| `\| count` | One row: the total number of rows. |
| `\| fields f1, f2, ...` | Choose the table's columns. It doesn't drop data; expanding a row still shows the full event. |
| `\| limit N` | Keep the first N rows. |

After `count by a.b`, the grouped field is still addressed as `a.b`.

## Worked examples

```
# Who called IAM write APIs, and from where?
eventSource = iam.amazonaws.com and readOnly = false | count by userIdentity.arn, sourceIPAddress

# Every event mentioning an indicator, in time order
"203.0.113.77" | sort ts

# Temporary keys seen from more than one IP
userIdentity.accessKeyId exists | count by userIdentity.accessKeyId, sourceIPAddress | count by userIdentity.accessKeyId | where count > 1

# Failed calls only, most common first
errorCode exists | count by eventName, errorCode

# A time window
ts >= 2026-11-10T23:45 and ts < 2026-11-11T00:15 | sort ts
```

## In the interface

- **Enter** runs the query. **Shift+Enter** adds a new line. **↑** at the start of the box recalls earlier queries.
- **Click a cell** to add `field = value` to the current condition.
- **Click a field in the sidebar** to replace the stages with `| count by <field>`.
- **▸** expands a row to show the full event as JSON.
- Answers are checked in the game's **Objectives** panel. Each answer is compared as a salted SHA-256 of its normalized form: trimmed, lowercased, with surrounding quotes, a leading `#`, an `http://`, `https://` or `s3://` prefix, and trailing `.` or `/` removed. Nothing leaves your browser.

## What it deliberately does not do

There are no regular expressions, joins, `let`, arithmetic, time bucketing, or functions such as `strlen()`. Challenges are written so you never need them. If you'd rather use real KQL, SPL, jq or pandas, every challenge also ships `artifacts/logs.json`.
