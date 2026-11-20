CHALL 2 - SAFE MODE
===================

An internal AI ops assistant can run a few 'safe' shell commands. Its
allowlist is not the wall it looks like. Get code execution and prove
the impact.

Type:        Red (exploit / repro)
Difficulty:  Intermediate
Time:        45-75 minutes
Skills:      MCP / tool servers, Command injection, Allowlist bypass,
             Exploitation with curl, Impact and remediation
Requires:    Docker Engine and the Docker Compose v2 plugin (the "docker
             compose" subcommand). See lab/REQUIREMENTS.txt.
Format:      A Docker lab you exploit from a terminal, plus a browser
             game for the objectives, hints and scoring. Runs offline.

GETTING STARTED
---------------
1. Get this folder onto your computer: clone the repository, or download
   it as a ZIP from GitHub and unzip it.

2. Install Docker Engine and the Docker Compose v2 plugin if you do not
   have them (https://docs.docker.com/get-started/get-docker/). You need
   the "docker compose" subcommand (two words, v2) -- not the old
   "docker-compose" binary. Verify with:
      docker compose version
   It must print a v2.x version. If it errors, see lab/REQUIREMENTS.txt.

3. Start the lab. Open a terminal, cd into "chall 2 - Safe Mode/lab",
   and run:
      docker compose up -d --build
   The target then listens on http://127.0.0.1:8808/mcp.

4. Open this folder and double-click play.html. It opens in your web
   browser (Chrome, Firefox, Edge or Safari). This is the game, and
   where you read the briefing and submit every answer. There is no
   server and no sign-up, and nothing leaves your machine.

5. Read the briefing, then choose a mode and a timebox and click "Begin
   investigation". The clock starts then.

6. Exploit the lab from your terminal, but submit every answer back in
   play.html, in the Objectives panel on the right. The terminal is only
   for running the attack; nothing you type there is graded. A wrong
   pick or a rejected plan in the game tells you why it is wrong.

7. When every objective is done, you get your score, the full story of
   what happened, and links to the real incidents that inspired this
   challenge. Click "End investigation" to stop early.

8. Shut the lab down when you are finished:
      docker compose down -v

MODES
-----
- Challenge mode: hints are locked. Solve it cold.
- Guided mode, deeper hints: hints that get more specific. Each hint
  costs points.
- Guided mode, walkthrough: step-by-step guidance that follows your
  progress. Steps are free; your score is marked as a walkthrough.

TIPS
----
- The lab speaks JSON-RPC over HTTP. You can drive it with nothing more
  than curl; the briefing and the in-game hints show how.
- Use the Notebook tab for your notes. It also records your hints and
  wrong answers.
- Your progress is saved in your browser. "Restart" in the top bar wipes
  it and starts again.
- The lab binds to 127.0.0.1 only and is sandboxed (all capabilities
  dropped, no-new-privileges, read-only filesystem, resource caps). It
  is safe to run locally. Never expose its port to a network.

WHAT IS IN THIS FOLDER
----------------------
readme.txt   This file.
play.html    The game. Start here.
lab/         The Docker lab target, plus REQUIREMENTS.txt (Docker +
             Compose v2). See GETTING STARTED above.
files/       Evidence and the game itself. Keep it
             next to play.html and do not rename it.

ABOUT THE DATA
--------------
Everything here is fictional: the company, people, accounts, keys, IP
addresses and domains. Credentials are obviously fake (they end in
EXAMPLE), and nothing in this folder is malicious. The lab target is
intentionally insecure for training, and only for that.
