# weekly-sec

**Hands-on security challenges built from real incidents.** Each one drops you into a realistic case: an alert to triage, an intrusion to reconstruct, a bug to reproduce or a detection to write. Every challenge is modeled on things that have actually happened. When you finish, you get the full story and links to the real-world incidents behind it.

There's no platform, login or leaderboard. Clone the repo, open a challenge folder and start.

> [!WARNING]
> Some challenges run **intentionally vulnerable software**. Each of these ships with a ready-made Docker setup in its `lab/` folder, so the vulnerable app runs in containers and never gets installed on your machine. You only need [Docker](https://docs.docker.com/get-started/get-docker/). Every lab is locked down, and the repo checks enforce it:
>
> - ports are reachable from your own machine only (`127.0.0.1`), never from your network;
> - no host networking and no privileged containers;
> - no access to your files outside the lab folder, and no access to Docker itself.
>
> Start a lab with `docker compose up -d` from its `lab/` folder. Remove it, data included, with `docker compose down -v` when you're done. For an extra margin, run labs in a VM rather than on a work laptop, and never on a machine reachable from the internet.
>
> No challenge ships real malware. Attacker behaviour is reconstructed as logs, text and harmless stand-ins. All names, accounts, keys, IPs and domains are fictional.

## Getting started

1. Clone the repo, or download it as a ZIP.
2. Open [`challenges/`](challenges/) and pick a folder, for example `chall 1 - Midnight Export`.
3. Open the **`readme.txt`** inside it. It says what the challenge is, how long it takes, and exactly how to start.

Challenges come in two formats:

- **Browser challenges.** Double-click `play.html` and the whole case runs in your browser, offline: briefing, logs, evidence, objectives, hints, scoring and the debrief. Nothing to install, no server, and nothing leaves your machine.
- **Terminal challenges.** You work in your own shell against a lab or a set of files. The challenge's `readme.txt` walks you through setup.

## How browser challenges work

- **Investigate.** Query the logs in the **Logs** tab, read configs and alerts in **Evidence**, and keep notes in the **Notebook**.
- **Answer the objectives.** Some take a short typed answer. Some are pick-one questions. Response and remediation questions are played on a board, where you drag actions into order and set aside the ones you wouldn't do. A wrong pick or a rejected plan tells you *why* it's wrong.
- **Pick your level.** **Challenge mode** locks the hints. **Guided mode** gives you either *deeper hints*, which end with the exact query to run, or a step-by-step *walkthrough* that follows your progress.
- **Debrief.** When every objective is done, or when you click **End investigation**, you see your score, what actually happened, and the real incidents that inspired the case.

Each objective has points. Hints, wrong picks and rejected plans cost some of them. Answers are checked against salted hashes, so the page can tell you whether you're right without containing the answer in readable form. It's still the honor system: anyone determined can dig through the files, but the practice is the point.

### The query language

The **Logs** tab uses a small filter language, fully specified in [`explorer/DSL.md`](explorer/DSL.md). It takes about two minutes to learn:

```
eventSource = iam.amazonaws.com and readOnly = false | count by userIdentity.arn, sourceIPAddress
```

It's deliberately **not** KQL or SPL. It trains the thinking that transfers to any SIEM: what to filter, what to pivot on, what to count. If you'd rather use your own tools, every log set also ships as plain JSON in the challenge's `files/artifacts/logs.json`.

## What the challenges cover

Challenges rotate across angles, so it isn't all blue team:

- **Red:** exploit a localhost-only lab, chain a bug, prove impact.
- **Blue:** triage an alert, write a detection, tune out false positives.
- **Purple:** exploit something, then detect or fix it.
- **DFIR:** reconstruct what happened from the artifacts.
- **Analysis:** take apart a payload, a malicious script or a config.

The topics: cloud (AWS, IAM, S3), CI/CD and software supply chain, automation and agent security, containers and Kubernetes, and current high-profile CVEs.

## Repository layout

```
challenges/     one folder per challenge: "chall N - Name/" with readme.txt, play.html and files/
explorer/       the browser game and log explorer (explorer.js), plus a standalone explorer.html and DSL.md
TEMPLATE/       the source format for a new browser challenge
tools/          build.js (source to playable folder) and check.js (repo checks, run in CI)
```

To build a browser challenge from a source folder shaped like `TEMPLATE/`:

```
node tools/build.js <source-folder> "challenges/chall N - Name"
node tools/check.js
```

Keep sources outside the published tree, since they contain the answers.

## Issues

Found a bug, an ambiguous question, or an answer that should be accepted but isn't? Open an issue. Please keep answers out of issue titles.
