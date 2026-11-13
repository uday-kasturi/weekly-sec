CHALL 1 - MIDNIGHT EXPORT
=========================

A CI role pulled customer data at midnight from an IP that isn't
GitHub's. Find out how, how far, and what to do.

Type:        Blue -> DFIR (alert triage -> investigation)
Difficulty:  Intermediate
Time:        60-90 minutes
Skills:      CloudTrail analysis, Pivoting on identifiers, GitHub
             Actions OIDC, Agent trace analysis, Scoping and containment
Format:      Browser game. Runs offline, with nothing to install.

GETTING STARTED
---------------
1. Get this folder onto your computer: clone the repository, or download
   it as a ZIP from GitHub and unzip it.
2. Open this folder and double-click play.html. It opens in your web
   browser (Chrome, Firefox, Edge or Safari). There is no server and no
   sign-up, and nothing leaves your machine.
3. Read the briefing. It explains the situation, the environment and
   what normal looks like. The clock does not start until you begin.
4. Choose a mode and a timebox, then click "Begin investigation".
      Challenge mode: hints locked. Solve it cold.
      Guided mode, deeper hints: hints that get more specific,
        ending with the exact query to run. Each hint costs points.
      Guided mode, walkthrough: step-by-step guidance that follows
        your progress. Steps are free; the score is marked as such.
5. Investigate in the Logs and Evidence tabs and answer the objectives
   on the right. A wrong pick or a rejected plan tells you why it is
   wrong.
6. When every objective is done, you get your score, the full story of
   what happened, and links to the real incidents that inspired this
   challenge. Click "End investigation" to stop early.

TIPS
----
- In Logs, click "Query help" for the query language. It takes two
  minutes to learn. Click any cell to filter on it, and click a field
  name to count its values.
- Use the Notebook tab for your notes. It also records your hints and
  wrong answers.
- Your progress is saved in your browser. "Restart" in the top bar wipes
  it and starts again.
- Prefer your own tools (jq, pandas, a SIEM)? The raw events are in
  files/artifacts/logs.json. You still answer in the game.

WHAT IS IN THIS FOLDER
----------------------
readme.txt   This file.
play.html    The challenge. Start here.
files/       Everything the game needs: logs, evidence and the game
             itself. Keep it next to play.html and do not rename it.

ABOUT THE DATA
--------------
Everything here is fictional: the company, people, accounts, keys, IP
addresses and domains. AWS keys end in EXAMPLE, and IP addresses come
from documentation-only ranges. Nothing in this folder is malicious.
