// Built by tools/build.js. Answers are salted SHA-256 hashes; hints, keys, walkthrough and story are
// sealed (obfuscated, not encrypted) so they can't be read by accident. Don't edit by hand.
window.WEEKLY_SEC_CHALLENGE = {
 "id": "chall-2-safe-mode",
 "week": "Chall 2",
 "title": "Safe Mode",
 "subtitle": "An internal AI ops assistant can run a few 'safe' shell commands. Its allowlist is not the wall it looks like. Get code execution and prove the impact.",
 "angle": "Red",
 "task": "Exploit / repro",
 "difficulty": "Intermediate",
 "minutes": "45-75",
 "skills": [
  "MCP / tool servers",
  "Command injection",
  "Allowlist bypass",
  "Exploitation with curl",
  "Impact and remediation"
 ],
 "salt": "f57ae8089dd980ff",
 "briefing": "## The engagement\n\nYou're on a red-team engagement against **Meadowlark Robotics**. Like a lot of teams this year, Meadowlark gave its internal AI assistant some *tools*: small server programs the assistant can call to get real work done. One of them is an **ops-assistant** that lets the assistant check on production services and run a few read-only diagnostic commands on the ops host.\n\nIt's an **MCP server** (Model Context Protocol, the standard way assistants expose tools). The platform team was careful: the command tool runs in **\"secure mode\"**, where every command's executable has to be on an allowlist before it runs. Only safe, read-only diagnostics, in theory.\n\nYou have network reach to the server. **Your job: show that \"secure mode\" doesn't hold, get code execution on the ops host, and spell out the impact and the fix.**\n\n## The target\n\nThe lab runs the ops-assistant in a container, reachable at:\n\n```\nhttp://127.0.0.1:8808/mcp\n```\n\nStart it from the challenge's `lab/` folder (`docker compose up -d --build`), as the `readme.txt` describes. The `Evidence` tab has the server's config and a normal session if you'd rather read first, but the flag and the proof-of-execution objectives need the live lab.\n\n## MCP in two minutes\n\nYou don't need an MCP client. The transport here is **JSON-RPC 2.0 over HTTP**: you POST a small JSON object to `/mcp` and read the JSON reply. Three calls matter.\n\n- **`initialize`**: the handshake. The server tells you its name and version.\n- **`tools/list`**: the server lists the tools it offers, each with a name, a description and an input schema.\n- **`tools/call`**: you invoke a tool by name, passing its arguments. The result comes back as text content.\n\nA call looks like this:\n\n```\ncurl -s -X POST http://127.0.0.1:8808/mcp \\\n  -H 'content-type: application/json' \\\n  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'\n```\n\nThat's the whole interface. Everything you need to solve this is one `curl` away.\n\n## What \"secure mode\" is supposed to do\n\nThe command tool is wrapped in a guard. Before it runs anything, it splits the command line, takes the **executable** (the first word), and checks it against an **allowlist** of permitted programs. If the executable isn't on the list, the command is refused. The idea is that an assistant (or anyone who can talk to it) can only ever run the handful of harmless, read-only commands the platform team approved.\n\nAn allowlist is only as strong as what's on it. Read the list in `security.yaml` and ask, for each entry: *what can this program be made to do?* A tool that prints a file can read any file the service can read. A program whose whole job is to run other programs is a door: it runs whatever you hand it.\n\n## Your goals\n\n1. **Enumerate.** Find the tool that runs commands, and read the allowlist that's supposed to contain it.\n2. **Break it.** Get the server to run something that is *not* on the allowlist. Capture the flag at `/flag.txt`, and prove you have arbitrary command execution, not just file reads.\n3. **Report.** Say what the real fix is (the one that actually closes it, not the ones that only look like fixes), and put the response actions in the right order.\n\n## How to work\n\n- Everything happens in your terminal against the lab, plus the **Objectives** panel on the right for your answers. There's no log explorer in this one.\n- The **Evidence** tab has `security.yaml` (the policy), the `tools/list` response, a normal session transcript, and the agent's recent calls. Read them to reason about the server before (or instead of) poking the live one.\n- Use the **Notebook** for your commands and findings. It also records your hints and wrong answers.\n- Stuck? Guided mode's **walkthrough** gives you the exact `curl` for each step. Deeper hints do the same at a point cost.\n- When every objective is done, you get the full write-up and the real CVEs this is built on.\n\n*Everything here is fictional. The credential ends in `EXAMPLE`. The lab target is deliberately insecure, for training only. Don't expose its port to a network.*\n",
 "evidence": [
  {
   "path": "artifacts/security.yaml",
   "label": "security.yaml",
   "note": "The ops-assistant's loaded security policy (secure mode + the command allowlist).",
   "content": "# Meadowlark ops-assistant -- MCP server security policy\n# Loaded at startup. \"Secure mode\" restricts run_command to an allowlist of\n# executables so the agent can only run safe, read-only diagnostics.\n\nsecurity:\n  secure_mode: true          # enforce the allowlist below\n  command_timeout_seconds: 10\n  max_output_bytes: 20000\n\n  # Only these executables may be run. Reviewed by the platform team.\n  allowed_executables:\n    - ls\n    - cat\n    - echo\n    - grep\n    - head\n    - tail\n    - wc\n    - uptime\n    - df\n    - bash        # for multi-step health checks, e.g. `bash -c \"...\"`\n\n  # Reserved for a future release: run without a shell and drop this allowlist.\n  # no_shell_mode: false\n"
  },
  {
   "path": "artifacts/tools-list.json",
   "label": "tools/list response",
   "note": "What the server advertises when an agent lists its tools.",
   "content": "{\n    \"jsonrpc\": \"2.0\",\n    \"id\": 2,\n    \"result\": {\n        \"tools\": [\n            {\n                \"name\": \"service_status\",\n                \"description\": \"Report whether a named internal service is up. Reads from a fixed status file.\",\n                \"inputSchema\": {\n                    \"type\": \"object\",\n                    \"properties\": {\n                        \"service\": {\n                            \"type\": \"string\",\n                            \"description\": \"service name, e.g. billing-api\"\n                        }\n                    },\n                    \"required\": [\n                        \"service\"\n                    ]\n                }\n            },\n            {\n                \"name\": \"read_metric\",\n                \"description\": \"Return the latest value of a whitelisted host metric (load, disk, mem).\",\n                \"inputSchema\": {\n                    \"type\": \"object\",\n                    \"properties\": {\n                        \"metric\": {\n                            \"type\": \"string\",\n                            \"enum\": [\n                                \"load\",\n                                \"disk\",\n                                \"mem\"\n                            ]\n                        }\n                    },\n                    \"required\": [\n                        \"metric\"\n                    ]\n                }\n            },\n            {\n                \"name\": \"run_command\",\n                \"description\": \"Run a diagnostic shell command on the ops host. Secure mode is enabled: the command's executable must be on the server allowlist, so only safe, read-only diagnostics can run.\",\n                \"inputSchema\": {\n                    \"type\": \"object\",\n                    \"properties\": {\n                        \"command\": {\n                            \"type\": \"string\",\n                            \"description\": \"the full command line to run\"\n                        }\n                    },\n                    \"required\": [\n                        \"command\"\n                    ]\n                }\n            }\n        ]\n    }\n}\n"
  },
  {
   "path": "artifacts/mcp-session.txt",
   "label": "mcp-session.txt",
   "note": "A normal agent session with the server. This is not the exploit.",
   "content": "# A normal session with the ops-assistant MCP server, captured from the agent.\n# Transport: JSON-RPC 2.0 over HTTP POST to /mcp. Nothing here is the exploit.\n\n--> POST /mcp\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{}}}\n<-- 200\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"meadowlark-ops-assistant\",\"version\":\"0.5.2\"}}}\n\n--> POST /mcp\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n<-- 200   (see tools-list.json)\n\n--> POST /mcp\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"run_command\",\"arguments\":{\"command\":\"uptime\"}}}\n<-- 200\n{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"ok\\\": true, \\\"exit_code\\\": 0, \\\"output\\\": \\\"02:10:07 up 9 days, load average: 0.41 0.37 0.33\\\"}\"}]}}\n\n--> POST /mcp\n{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"run_command\",\"arguments\":{\"command\":\"id\"}}}\n<-- 200\n{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"ok\\\": false, \\\"error\\\": \\\"blocked by secure mode: 'id' is not on the allowlist (ls, cat, echo, grep, head, tail, wc, uptime, df, bash)\\\"}\"}]}}\n"
  },
  {
   "path": "artifacts/agent.jsonl",
   "label": "agent.jsonl",
   "note": "The ops agent's recent tool calls.",
   "content": "{\"ts\":\"2026-11-16T02:10:04Z\",\"actor\":\"ops-agent\",\"event\":\"tool_call\",\"tool\":\"service_status\",\"args\":{\"service\":\"billing-api\"},\"output\":\"up (healthy, 3 replicas)\"}\n{\"ts\":\"2026-11-16T02:10:05Z\",\"actor\":\"ops-agent\",\"event\":\"tool_call\",\"tool\":\"read_metric\",\"args\":{\"metric\":\"disk\"},\"output\":\"61% of 200G used\"}\n{\"ts\":\"2026-11-16T02:10:07Z\",\"actor\":\"ops-agent\",\"event\":\"tool_call\",\"tool\":\"run_command\",\"args\":{\"command\":\"uptime\"},\"output\":\"ok: 02:10:07 up 9 days, load average: 0.41 0.37 0.33\"}\n{\"ts\":\"2026-11-16T06:30:11Z\",\"actor\":\"ops-agent\",\"event\":\"tool_call\",\"tool\":\"run_command\",\"args\":{\"command\":\"df -h /\"},\"output\":\"ok: /dev/root 200G 122G 78G 61% /\"}\n{\"ts\":\"2026-11-16T06:30:12Z\",\"actor\":\"ops-agent\",\"event\":\"tool_call\",\"tool\":\"service_status\",\"args\":{\"service\":\"etl-nightly\"},\"output\":\"idle (last run 02:14 UTC, ok)\"}\n"
  }
 ],
 "questions": [
  {
   "id": "q1",
   "kind": "answer",
   "points": 15,
   "short": "The dangerous tool",
   "prompt": "List the server's tools. Which one runs shell commands on the ops host?",
   "placeholder": "tool name",
   "hints": [
    {
     "cost": 2,
     "text": "KZVx4JPRtGnf4Km3WmnEIBN+B9y9vDOBUzDMZ3vDkR4EiH+NkfL/OtPm5fJbLMsgRXpV4oeAGN8hCfs0O8ORHgSIfsG58uB6muaw8lwhwGQAdRHYu6Y4hl15kFspl4wUCZ9x2bjktHrO/bC+W2bJLRZvVdqxvCadHSrddHvekFEtjTjJte/3f5S7"
    },
    {
     "cost": 4,
     "text": "CJgk37yhuWmav4fyeAb2EEVzAdyk9XndQmuPOmuZzl9ZwWmV4Lm7d9ni//9gaYInCnUBzbq7e4YKKd0ue9aOAQSSMsyk6Pt0lfisvUZuhWkBO1LT9qUlnR0ryHd5jdxDRstzgfLo8DiAo/PwRSzRLAp/V5L2uzmdHyqXeDLEilMV3DGN8NXjdZrmsL1EOoUuEGgBiKaqN5ZTP9FsPtPeFQmPMJbw7vp/mua+uU06hSVFbB3HuKp2kRw01XU1094dAZU0gw=="
    }
   ],
   "guide": [
    {
     "text": "PJM0jaPk5mzf4P+hWCzELxY7P/ubgXugIxqYJnWH3h4eniONmNXASpSyjKZJO9FkEnIBwPS7PpdTMdl6P8SWEAOea42w4uFo1rLyoQhk/WQ1VCb89KcihgNjlztqhclfWNVhg+G7rCKKqvC/SzmFaS07Usu7oSKXHS2VYCLHm0tImiHdvOj3e877sLwHI9YrCzxVhbDvcYlRM8t7NcWOEkrBc5/+sbY2mPu78BJ4iWYIfgHAu6t0yFEw1n0v3p8dAYE0j/yj5HvI87KhCnPeORg8FYb0gTmGFnnPfDrD3hIHljTe8OP1edGo/7hdOtFkEXMQiKeqJIQWK59ne9mfHA3bMMO0oeJ/yOG2vUZpxCoBOxSIsqM3lVMt0HUvl5cFSNE5zKOrtG7V/bOhBmnsMEV/Gs2n7zidB3nUfSjD3gUAnjyB8PL7Ot79sfVcacIrRXcax7+mOJVTP9dme9eMBAakMsK97PV03vL/uk07wGpFTx3N9Kc3nBcq0HUw0t4YG9s+3aTo+3Tb/uTyXCHAZAt+Ddz0rDeeH3nRZ3vDlhRIlD/I8PX8e86ysrNcPcA2FjU="
    },
    {
     "text": "JpQmjbzo526a5re3CD3KKwloT4i0rCOAH3mVZ3uaplE4tAL58Ongbsqo8P0Ze5JqVTVFhuX1bspDYZd5OMfeXCDbds6/7+B/1ObyplE5wH5FegXYuKY1kwcw13p03Y0eBtxxgLShs2GY+Ky9RjvVJ0chV5r6/3TeUTDcNmGF0lMFniXFv+W2IJjmsL1EOoooDGgBiqnoNtxTC911P5eKGQ3bNcij4uZzyua2vUY6n2QFaBDaoqY1lywqzHUvwo0RSJo/yfDh5n/b9oC/TT3XLQZ7VcmmqnaREjfWcT+b3hMdj3HCvuS0btX9s/JcKM4hFjsUiLK9M5deP9dmNpeeEgeWPMy+5fQ0msa3s1xpyioAOxzb9Ls+l1M41mcs0oxf"
    }
   ],
   "story": "MZQkjaP19WjOsqi7XCGFJQl2Gtug7zidBzHRejyN3hBIrgPh8PX8e86yurxMOoUtCzsVh7msJpJTONZwe9beHwePNI2k6fVumua3twg9xDYCfgGIvbx2kx159VcLl40UGo003/6hwHLb5v+hXS/DLR07HNv0uz6XUz/RZijD3gUBi3+NncLEOtPh/7MIOdcrEXQWx7jjdpMdPZhxLdKMCEiINN+m5OY6zvq+pgg61SEEcAaIvbt2mx4p1HE20pAFG9slxbWh53vX9/+2QTrGKxN+B9H0rDeeH3WYZzSXhx4d2z/IpuTmOtLzqbcIPcpkAm4Q26fvIZoSLZhgM96NUQeVNI2z4Po63v3x8mk6zmQMb1Xfvbs+0hMt13s3xNEdAYglzfDg+n6a+6vyQCjLIBY7DMeh7z+GAHnXYzWXkxQGjn+Nnu7jOsj3vrYIPs0lETsQybendoYcNtQ0ccOfGg2Ie4Hw4/F52+estwg9zSUROxzb9Lg+kwd5zHE3241RHJM0jbTg+n3f4LCnW2nKKgA7FNi1vSLcUznLcSnBlxINpCLZsfXhadqyqLNGPdZkBDsGzaa5P5EWedZ1NtLeEAafcc2i5PV+5f+6plogxiRFbBTGoLx2k1M03WAp3p1RBpo8yOqh9nXO+v+iQSrOZANpGsX0rnaUGiHdcHvEmwVImj/J8On1dN6yvbNLIoUnBHUbzbDvMpMHOJY0O8WLHzeYPsC94Pp+2rKrs0Ms1mQEOxPasap7lBwr1TQ71JEcBZo/ybCh527I+7G1CCjLIEVpAMan7z+GUzbWNC/fm1EAlCLZ/qHVOs79sL4IPc0lETsUy7eqJoYAedlmOd6KAwmJKI2k5OxumvOxtggs3SEGbgHNp+8/hlMwyzQv35tRH5M+wbWh9W7O87y5CDrQNgN6Fs347yWdUy3QdS+XlwJIjDnIouS0Y9Xn/7VHZw==",
   "hashes": [
    "e3bee09ac9a095f547f73212fd9a0fe21c96fdc2c7041fc7bc32b43cedb4ebd0"
   ],
   "answer": "Go4/8rPu+Xfb/Ls=",
   "visibleAnswer": true
  },
  {
   "id": "q2",
   "kind": "answer",
   "points": 15,
   "short": "The hole in the wall",
   "prompt": "run_command is in 'secure mode': the executable must be on an allowlist. Which allowlisted executable makes that allowlist meaningless, turning read-only diagnostics into arbitrary command execution?",
   "placeholder": "executable name",
   "hints": [
    {
     "cost": 2,
     "text": "Op4wyfDh53/Z5627XDCLPQR2Gcj0pjjSNi/RcD7ZnRRG2wXFtaH1dtb9qL5BOtFkCXQaw6fvNZMBPN5hN43eHRvXcc6x9bg63eC6ogRpzSEEf1uG+u83nBd513o+l5sfHIkojaTp9W6a+6zyRibRZAlyHs30uz6XUzbMfD7FjV8="
    },
    {
     "cost": 4,
     "text": "PJM0jbPp8XnRsrC8RDCFKAp0Htv0riLSBzHdND3ejAIc2ybCouW0ddyyq7pNacYrCHYUxrDvfoYbPJhxI9KdBByaM8G1qLo68/T/pkAo0WQSdAfM9KYl0hoty3E30d4QSIg5yLztuDrO+rrySSXJKxJ3HNug7z+BUynXfTXDkhQbiGuNpOnxOsn6ur5EadItCXdV2qGhdoUbOMxxLdKMURGUJI2g4Odpmvur/A=="
    }
   ],
   "guide": [
    {
     "text": "J4s0w/Dh53/Z5627XDCLPQR2Gcj05xOEGj3dejjS0lEHiXHLue3xaZXzraZBL8QnEWha27GsI4AaLcE6ItaTHUHVcd614uFo382yvUwshS0WOwHaoap2kx09mHQ625IeH5418rX58XnP5r6wRCzWJEV3HNugvHaBEj/dOTfYkRoBlTaNouT1fprmsL1EOolkFXcA2/SvNJMAMdg6"
    },
    {
     "text": "PJM0jaPk5mzf4P+kSSXMIARvENv0uz6XUzzAcTjCihAKlzSN+ODmfczJ748BacQjBHIb26DvIpoSLZh4MsSKXUiPOci+oeZv1OH/pkAshScKdhjJuqt2lhor3Xcv24dfSLI3jbHz82zhooLyQTqFJAd6BsC043aGGzyYdzPSnRpIizDeo+TnOtv8u/JKKNYsRWkAxqfvL50GK5h1KdCLHA2VJd7+odV21v2ovkE60S0LfFXJ9Lw+lx81mHA+0ZsQHIhx2bjktHvW/rClRCDWMEs7IcCx7zecAC7dZnvejVEckzDZ8OTsf9nnq7NKJcBq"
    }
   ],
   "story": "MZQkjbjg4n+a8/+mRybJZBFzFNz0vSOcAHnbezbanx8MiH2NsvTgOtPm/6VHJ4IwRWkAxvSlI4EHedl6IsOWGAaca42k6fE62f2xtEEuhTcEYgaItLwzkQYr3Us22JoUUtsl36Xk9Drb/LvyWCbMKhFoVcmg7zecUznZeDfYiRQMpDTVteLhbtvws7dbKYUoDGgBhvSbPpMHedt7NdGXFkiSIo2p7uFomvy6qlxp1yEEf1uIm78znFM5y3E4wowYHIJ/1LHs+Hqa87G2CC7KZAF0Asb0uz6XUzXRZy+XjR4ajzjDt6Hxe9n6/7dGPdc9RXIb3LvvOZwWeddye8OJHkiLOMG18ro69/2spggo1yFFdxDJsu81nR402Xo/xMRRCJcizfyh9Hnb5r/+CCnCNgBrFYT0rz6XEj3YND7WnRlInz6Nv+/xOsn/vr5Eac8rBzsUxrDvJYYcKZY0FNmbUQ2VJd+pofB13+H/vEc9hSYAdxrGs+8hmwcxmGAz0pNfSJszzKPp9DrT4f+zRmnMKhF+B9imqiKXAXWYdTXT3hAG2zjDpOTmasj3q7daacA8DGgB2/S7OdIBLNY0NMOWFBrbId+/5uZ71+H/tEc7hT0KbluIgKc3hlM00Wc21ooSANs43vD1/H+a5rq+RGeFEA1+VduxvSCXAXnXejfO3hIAnjLGo6Hgct+yubtaOtFkEnQHzPSgMNIKNs1me9SRHAWaP8nw4PN70/yspgg9zS0WOxnBp7t60gA2mGAz0t4cB5Y0w6Sh4HLfsrm7WjrRZBJ0B8z0piXSEnnIZjTQjBAF2yXFsfW0aM/8rPJJJ9wwDXIbz/jvIpoWedR9KMPeAhyUId7w7PF71PuxtQgoyz0RcxzGs+F2oRY6zWY+l5MeDJ5xxKOh9XbI9762UWnKMgBpToi6oCHSCjbNNCvFkQcN2zjZ/g==",
   "hashes": [
    "cc2da9c0c2897f83af3e75d04e4b0736d7d9dde59dab4ff48f337f072f133ef3",
    "24a571e92ea81902864ccef55350e8cd9783fd01963003806fede26347689a23"
   ],
   "answer": "CpoixQ==",
   "visibleAnswer": true
  },
  {
   "id": "q3",
   "kind": "answer",
   "points": 20,
   "short": "Capture the flag",
   "prompt": "There is a flag at /flag.txt on the ops host. Exploit run_command to read it. What is the flag?",
   "placeholder": "WSEC{...}",
   "hints": [
    {
     "cost": 2,
     "text": "MZQkjbPg+Haa8/+mRybJZBJyAcD0hQW9PXTqRBiXngUHlD3e/+L1dtby8/JYKNY3DHUSiKCnM9IHNtd4e9mfHA3bMMO0of1uybK+oE88yCELbwaG9L0jnCw613k21pAVSIwww6TytHua8ry9RSTEKgF7VdugvT+cFHc="
    },
    {
     "cost": 4,
     "text": "Kds3xLzkuWjf87u7Ri6FMAp0GYi7oXaGGzyYdTfbkQYEkiLZ8Kn3e86+/7pNKMFtRXoZ2rGuMotTK911P8TeEAaCccu57fE6zvq68lss1zIMeBCIt6440gE82XB1l64eAZUljbn1tHvOsqu6TWnDKAR8Ww=="
    },
    {
     "cost": 7,
     "text": "CJgk37yhuWmav4fyeAb2EEVzAdyk9XndQmuPOmuZzl9ZwWmV4Lm7d9ni//9gaYInCnUBzbq7e4YKKd0ue9aOAQSSMsyk6Pt0lfisvUZuhWkBO1LT9qUlnR0ryHd5jdxDRstzgfLo8DiAofPwRSzRLAp/V5L2uzmdHyqXdzrbklNE2SHMouD5aZiopPBGKMghRyFX2qGhCZEcNNV1NdPcXUqaI8ql7PF0zuH96FNrxisIdhTGsO1s0BA4zDR00ZIQD9Ul1aSj6WfHtb/yCB3NIUV9Gcmz7z+BUzDWNC/fm1EclD7B9/K0bt/qq/JHPNE0EG9b"
    }
   ],
   "guide": [
    {
     "text": "K5o9wfD1/H+a5rC9RGeFEA1+Vdu8riaXUzDLNDvDkR4EiH7Ose34eprltqZAacU0BGkUxafhOJMePNg0ZpeMBAakMsK97PV03rK+vExpxTQEaRTFp+E3gBQs1XE1w41fC5Q8wLHv8Hqar/+mQCyFJwp2GMm6q3aeGjfdOg=="
    },
    {
     "text": "LY00w/D2/W7S/aqmCD3NIUV5FNu87yKAGjrTOHvWkFEJlz3Cp+39ac73u/JaLMQgRW8ax7jvOpcSMss0Pd6SFBvBcc3+r7o42f2yv0knwWZfORbJoO95lB843zovz4pTRtV/zf6hxm/UsramCCjLIEVpEMmw7yKaFnneeDrQ3h4dj3HCtqHgct+ylYFnB4UwAGMBiKCnM9IHNtd4e8WbBR2JP97+obxO0vus8kkl1yEEfwyIp6c5hQB5zHw+l9kCCZ00jaLk9X6X/bG+UW6FJQl3Gt+4piWGUzDLNDXYilEbmjfI/qg="
    }
   ],
   "story": "Kp43wqLktGPV5/+gTSjGLEV9Gtr0uz6XUzvZZzOXnAgYmiLe/KH4ddX5/7BJKs5kBG9V3LyqdpMfNddjN96NBUiCPtjw6+FpzrKtt0kti2Qsb1XJpL8knQU83DQ71J8FCNdxzbjk9X7avv+zRi2FJAJpENi09XaGGyvdcXvTlxcOniPIvvW0bdvrrPJcJoU0F3Ib3PS7PpdTOtd6L9KQBRvbPsvw4LR80/66/AgdzSUROxzb9K52hhY11DQ02d4YHIhxwqfvujr7srm7RCyFNgB6Ec2m7zmcUzjWNDrbkh4flzjepKH3e9SyrbdJLYVuBHUMgvSpP54Wecx8PpeNFBqNOM61ofV52f2qvFxpxiULOxrYsaF60hI33DQ12JweDIJx3rPu5H/esramCD3KZAQ7BsmyqnaWGivddy/YjAhG2wLC8Pj7b5rmrasIPc0hRXgdzbW/doISLdA0Pd6MAhzBcc6x7fg62uCqvHcqyikIehvMtO8hmwcxmHQ41opRR509zLev4GLO8vPySSeFIR1+Ft2grjSeFnnMfDrD3hgb2zfYvO3tOtvir6BHP8AgSTsbx/S7JJsQMph9NcGRHR6eNYPw1fx/mvSzs09pxisIfgaIp7skkxo+0GB71Z8SA9Vx9L/0tHTf5LqgCCvAKhE7FIinpjiVHzyYZi7bm11IjDnEs+m0c8myq7pNadUrDHUBhvSOdtUAON5xd5eMFAmffMK+7e09mvOzvkc+yS0Wb1XcvK4i0hA41jQrxZcfHNsw37Lo4Gjb4KbyTiDJIRY7FMSmqjeWCnnUcTrcjVEbnjLftfXnNA==",
   "hashes": [
    "0befbc47a512a5494919a06a7b5cbe53423c6a29730b2979db07aee89e7c10a7"
   ],
   "answer": "P6gU7qvj9WnSzbC8dz3NITp6GcS7uDqbAC3nfSjojQUBlz3ysd7nct/+s68="
  },
  {
   "id": "q4",
   "kind": "answer",
   "points": 15,
   "short": "Prove code execution",
   "prompt": "Reading files is bad, but prove you have arbitrary command execution, not just file reads. Run `id` through the server (it is not on the allowlist, so you must bypass it). Paste its full output line.",
   "placeholder": "uid=...",
   "hints": [
    {
     "cost": 2,
     "text": "CJI1zfDo5zrU/avyRyeFMA1+Vcm4ozmFHzDLYHeXjR5ImDDBvOj6fZr7q/JMINchBm8Z0fSmJdIRNdd3MNKaX0i5JNnw4LRp0vezvggmy2QRcxCItaM6nQQ10Wcvl4kYBJdx36XvtHPOsrm9WmncKxA1"
    },
    {
     "cost": 4,
     "text": "I5403fDh9nvJ+r/ySTqFMA1+Vc2sqjWHBzjaeD6Xnx8M2znMvuW0c86yq7pNadchBHdVy7uiO5MdPYI0O9WfAgDbfM7w6PB6lLKRvV9pxDYCbS6Yie8/gVM72Wczl9YQBJc+2rXlvTrb/LvySijWLEVpAMan7z+WXQ=="
    },
    {
     "cost": 7,
     "text": "CNV/g/Li+3fX87G2CnOHJgRoHYj5rHabF3uWOnXX3gUAiT7Yt+m0btX9s6EHKsQoCTVV/Lyqdp0GLchhL5eSGAaeccSjoeFz3q/x/AZhyjQWMluIgKc3hlMwyzQ42JoUSJ4pyLP04HPV/P+zW2nRLAA7Bs2muT+RFnnZdzjYix8c1Q=="
    }
   ],
   "guide": [
    {
     "text": "PIkojbDo8Hqa9ragTSrRKBw7E8GmvCLSEjfcNCzWihIA2zjZ8Obxbprws71LIsAgRTNSxru7dp0decx8PpefHQSUJsG58uA9k7z/hkAo0WQMaFXcvKp2kRw3zGY0294IB45xzKLktHvY/aqmCD3KZAdiBcmnvHg="
    },
    {
     "text": "JpQmjafz9Wqa+6voCDrAMEV7Fse5ojecFzmYYDSXnhMJiDmN/eK0c97y8fJ8IcBkBHcZx6OjP4EHectxPsTeEwmIOY344Ph21eW6tgFyhSYEaB2Ipro4gVMw3Dp79JEBEdslxbWh8m/W/v+yXSDBeUs1W8j0oz+cFnneZjTa3gUAnnHCpfXkb868/4FfKNVkDHVVybq2dpEcNNV1NdPeGQ2JNIHw5Lp9lLK/sEk6zWRIeFWPsaEg1RN5ynEt0p8dG9slxbWh53/I5LqgDzqFIABrGcet7zWAFj3dei/enx1G"
    }
   ],
   "story": "Op4wybnv8zrbsrm7RCyFNBd0A82n7yKaFnnZeDfYiR0BiCWNvOT1ccm+/7BdPYUqCm9V3LyuItIKNs00ONaQURqOP42n6fVu3+S6oAgwyjFFbBTGoOF2tBwrmGAz1opREZQkjb7k8X6a5rDyWjzLZAQ7Bdq7qCSTHnnMfDrD3hgblXbZ8O76Os76uvJEINYwRXoBiLWjOt5TONZwe8OWFEiYPcix7/FpzrKvoEcmw2QMaFXJ9Kw5nx441nB7w5YQHNs1wrXytHTV5re7Ri6FJhBvVcGwqjiGGj/BNCLYi19IvTjfo/W0edX8ubtaJIUwDX5Vy7uhIoAcNZh9KJeMFAmXa42x8v862uCqvHcqyikIehvMtO8inVMrzXp715cVCNs1xKLk927W6/PySSfBZBJ6Acu87yWXECzKcXvakRUN2yPItvTnf5r7q/JKLMYlEGgQiLSmMpJTMMs0NdiKUQmLId+/9/F+lLKLukk9hTYAfQDbtaN2mwB533s0094fDYwig/DI4DrO97O+W2ncKxA7AcCx7zWaFjrTNCzYjBob2zTVseLgdsOyvqEILcA3DHwbzbDjdoUbMNt8e96NUR+TMNnw7PVx3+H/pkAshSoAYwGIuaAgl1M92Xk13pAWRtsfwqeh4Wnfsqu6TWnKIAE7EMagvS/SFSvXeXvEihQY2yXav6+0Sd/m/6ZALIUnCnYYybqrdoYcedh2OsSWUUWYccS04a46zvq68k4g1zcROwLHpqt2mwB52HY6xJYRRNsmxbni/DrT4f+zWDnXKxN+EYT0vDnSBzHdNDjfmxID2yHMo/LxaZrzsbYIK8Q3DTsH3bq8dpIaPdg0PdiMURGUJIPw1fx/mv2qplg80WQMaFXIoaYyz0JpiCRqn5EBG9J/g/7huDrZ/bu3CCzdIQZuAcG7oXaTAHnMfD6XjRQajTjOtaH1edn9qrxcZ4UXEnoFiLSmMpJTP9dme9ebHx6bccy+5bRu0vf/tk05ySscOx7Nre8/nFMt0HF7xJsDHp4jiqOh8XTM+629RiTAKhE7E8m4oyXSHCzMNC/YkV8=",
   "hashes": [
    "1dac01b31dcf12097d64597667505448442a4335008f0ca7c0728dcd62929b2f"
   ],
   "answer": "HZI1kOGxpCqLurCiW2CFIwx/SJnk/2bDWzbIZ3KXmQMHjiHe7bCkKoqj971YOow="
  },
  {
   "id": "q5",
   "kind": "choice",
   "points": 20,
   "short": "The real fix",
   "prompt": "The team wants to keep run_command but make secure mode actually safe. Which change closes the hole?",
   "wrongCost": 2,
   "hints": [
    {
     "cost": 2,
     "text": "KYg6jb/ntH/b8bfyRznRLQp1T4i1qSKXAXnMfDLE3hIAmj/Kta20ftX3rPJIK8Q3DTtYy/ToapMdIMx8MtmZT0+bcd6k6Ph2muCqvBdp7CJFYhDb+O8imhZ50Hs30t4YG9s+3bXvug=="
    }
   ],
   "guide": [
    {
     "text": "PJM0jbL08zrT4f+8Rz2FLQtxEMugpjmcUy3QZjTCmRlIljTZseL8e8jzvKZNO9ZkTW8dzfS8M4AFPMo0OtuMFAmfKI2i9PppmvOttV5pwS0XfhbcuLZ60h02mGcz0pIdSIsw36Po+n2TvP+GQCyFJhB8VcGn7yKaEi2YdXvElhQEl3HEo6H1dJrzs75HPsAgRX4Nzbe6IpMRNd06e+WLHQ3bPtikofV0w7K5u1Bp0SwEb1XEsa4glwB52nUo394eBtslxbWh9XbW/ai+QTrRaEVvHc267yabEDKYYDPS3h4GnnHZuODgOsj3sr1eLNZkEXMQiL2hIpcBKcpxL9KMXw=="
    }
   ],
   "story": "LpQk3/Dn/WLf4f+zWiyFKws7AcCx7yKTETXdNDrZmlEckzTU8OD4dprhsKdGLYU2AGgFx7q8P5AfPJQ0KNjeCAeOccO15PA627Kos1Fp0StFbxDEuO8imhZ5ynE6294eBp5xy6Lu+TrO+rryTCzGKxxoW4iEuiLSBzHdNCjWkxRIiiTIo/X9ddSyq70ILMQnDSFVybK7M4BTLdB9KJedGQmVNsj8ofB13+H/skoo1ixFNhaI8/M3nAot0H010MBWCNsi2bnt+DrI57HtCAzWJwRrHMaz7zuXBzjbfDrFnxIcniPe8Of1c9bh/7tcZYUmAHgU3aeqdoYbPMpxe96NUQaUcd645Ph2muaw8kEnzyEGb1XBurs50hI33DQi2ItRBp4nyKKh+n/f9rq2CCiFKQBvFMu8riSTEC3dZmCXnhMJiDnN8Pb1aZrzsfJJJckrEn4RiKS9OZUBONU6e/mRH0WJPsKkoeNzzvr/tlom1TQAf1XLtb83kBo10WAy0o1RDpo4waOh/W6Wsr23SyjQNwA7AcC1u3aREinLNC/fm1EMmjzMt+S0eM/m/6ZALIU3DX4ZxPS8IpsfNZhmLtmNUQmVNY2j9f121rKtt0kt1mQRcxCIv6ov3FMYzWAzl58fDNsF4YOh8nvT/v+7XGWFJgB4FN2nqnaGGzzBND/SnRgMnnHauO60aN/zvLpNOoUwDX5V3LugOt5TN9dge8CWEBzbJcW1oeB11f7/tkcs1mpFVBvEre85nBZ52XoowJsDSI8wxrXytG7S9/+hQCzJKEV0E870uz6XUzjUeDTAkhgbj32No+60etjzrLoIZMYkRXIGiKaqMIcAPNw0OtmaURyTNI286OdumvS2vEklyT1FeBrGp7skkxo3yzQs358FSIkkw6OvtE7S86vyQTqFMA1+Vc69t3rSEjfcNDLD3hgb2yXFtaH7dN+yq7pNadchBHdV2KagPJcQLZhnM96OAQ2ffw==",
   "options": [
    {
     "id": "o1",
     "text": "Run the container as a non-root user with all capabilities dropped."
    },
    {
     "id": "o2",
     "text": "Remove every shell interpreter (bash, sh) from the allowlist, and run allowlisted commands directly with no shell."
    },
    {
     "id": "o3",
     "text": "Put the MCP endpoint behind authentication and TLS."
    },
    {
     "id": "o4",
     "text": "Escape shell metacharacters (; | && backticks) in the command before running it."
    }
   ],
   "key": "E9kywqLz8XnOsOXwR3uHaEdsHdH29S3QHGiaLnnwkR4M2znMouXxdNP8uP4IKMsgRW8dwafvOpMRedl4KdKfFRHbNcK18rRzzr7/sF09hS0ROxrGuLZ2nho00WAol4oZDdszwbHy4DrI87u7XTqLZDFzEIi1uyKTEDLdZnvEihgEl3HKtfXnOtn9u7cILN0hBm4BwbuhdpMAecx8OsPeBBueI4Hw8/F73uH/pkAshSIJehKE9K44llMqzHE6241RHJM0jbTk5HbV6/+5TTCLZkk5Gpr29XSlGi3QNDXY3gIAnj3B8O76Os76uvJJJckrEncc26DjdpIROMt8e5qdEUiSIo2i5P5/2ea6tggoyyBFbx3N9K46nhwu1H0ow94XAZUwwbz4tHnV/KymWijMKhY7AsC1u3aABjfLOnvjlhgb2zje8Pb8e86yq7pNadchBHdVzr23dpYaPYI0MsPeAhyUId215bRp0vuvokEnwmQWcxDEuO8/nAc8ymQp0ooUGohxxL6h4HLfsru3TijQKBE7FMS4oCGeGirMOnmb3B5b2WuPhOn1bprxsLxcO8ooFjsCwLvvNZMdecpxOtSWURyTNI2k7vt2lrKxvVxp0iwEb1XcvKp2hhw21DQ/2JsCRtsQw6mh9W/O+rCgQTPAIEV6Es26u3rSHCuYdTXOihkBlTaNpOn1bpr7sbhNKtE3RXIb3LvvP4ZfectgMtuSUQ+eJd7w4OZ40+ats1owhSEdfhbdoKY5nF17lDY0g9xLSq85yKLktHPJsrG9CDrNIQl3Vdy77z+cGTzbYHvekAUHwXHZuOS0ad/gqbdaacQoF34UzK3vJIcdKph1KdCIUQySI8iz9fhjlLKLuk1p1TYKeRnNue8/gVMt0HUvl54TCYg5zfDo4Gnf/rnyQTqFJQs7FMS4oCGXF3ndbD7UiwUJmT3I/KHndZrrsKcIJ8AyAGlVxrGqMpcXedk0NtKKEAuTMN+x4uB/yLz/l1sqxDQMdRKIt6c3nBQ8yzQ12IoZAZU2g/L86Q=="
  },
  {
   "id": "q6",
   "kind": "rank",
   "points": 15,
   "short": "Response plan",
   "prompt": "You've proven RCE on the ops-assistant and reported it. It's live in production. Drag the response actions into the order you'd start them. Anything you wouldn't do goes under Don't do.",
   "board": "Response board",
   "wrongCost": 2,
   "hints": [
    {
     "cost": 2,
     "text": "LpIj3qSh527V4v+lQCjRZAR1VcmguzeRGDzKNDjWkFEMlHHfueb8bpr8sKUGafEsADsGzaa5M4BTMMs0KdKfEgCaM8G1ofV03rK4u14s1mQGdBHN9KoulxAszH002d4FAJIijaPk93XU9vE="
    }
   ],
   "guide": [
    {
     "text": "J4k1yKKh9mOa5621TSfGPV87Ft2g7zqbBTyYdTjUmwIb2zfEovLgNprmt7dGacYrC28UwbrvIpoWed51N9uRBBzbedm45LR/wuKwoU0thScXfhHNurs/kx9wlDQv35sfSJ041fD1/H+a8Kq1BGnSLRFzVc2ipjKXHTrdNDjWjgUdiTTJ8OPxfNXguvJJJ9wwDXIbz/S7PpMHec99K9KNURyTNI2i9Pp00/y48ksmyzAEchvNpuE="
    }
   ],
   "story": "KZVxxL7i/X7f/KvyWCXEKkVyBoi17yWdAS3RejyXjgMHmT3Iva20e9T2/6ZfJoUiBHgB2/SpP4pTLdBxe9iMFQ2Jf42E6fE63PutoVxzhTANflXNrL86nRotmH0ol5IYHp5/jYTp8TrO/bC+CCDWZBd+FMu8rjSeFnnZej+XmRgeniKNs+7wf5r3p7dLPNEtCnVV3LymJdIAPNt7NdPSURuUcdq44OB/zPet8ls9yjQWOwHAse80nhY83H010N4SB5Y03vDj8XzV4LryXyHEMABtENr0oDieCnnbeD7WkAJIjiGD8Nj7b5rmvrlNadEsADsBx7ujdp0VP5hgM9LeHw2PJsKi6rR80+CspgZp8SwAOwbNt6A4lkl5y3s20t4QC484wr7ytH7f4augRzCFLQt9Gtq5riKbHDeWNAnYihAckj/K8PX8f5r+urNDLMFkDn4MhPS8PpsDKdF6PJeKGQ3bN8SorbR71Pb/oE0twDQJdAzBuqh2kx81mHAyxIoEGplx2bjktGjP/LG7Ri6FJwp1Acm9oTOAX3nLe3vOkQRIiyPIo+TmbN+ytqZbackrAmhVybqrdoYbPJh1PNKQBUiPI8yz5LR43/SwoE1pxCocOxrO9Ls+lx53mFEt0owIHJM4w7eh8XbJ9/PyXDvAJRFyG8/0uz6XUzLdbXvWjVEKjiPDteW4Osrzq7FAIMsjSTsd3bq7P5wUecx8PpeYHQ2eJY227uY6zvq68lsoyCFFfRnJo+N2gR82zGd73pBRCYk+2L7ltG7S/ay3CD3SK0VpAMSxvHjSNDzMNC/fm1EHiTXIoqHjaNX8uPJJJ8FkHHQAiLGmIpoWK5h4PtaIFEiPOcjw6ft237Kwok0nhTMNchnN9LY5h1Mt0XAil4sBRNs+3/D2/Wrfsqu6TWnAMgx/EMa3qnaLHCyYej7SmhQM1Q==",
   "items": [
    {
     "id": "t1",
     "text": "Preserve evidence: the server's request logs and the agent trace, before you redeploy."
    },
    {
     "id": "t2",
     "text": "Hunt the fleet for other MCP tool servers that expose a shell or a weak allowlist."
    },
    {
     "id": "t3",
     "text": "Delete the server's logs to tidy up the incident."
    },
    {
     "id": "t4",
     "text": "Leave run_command as-is and tell the agent, in its system prompt, not to use bash."
    },
    {
     "id": "t5",
     "text": "Ship the fix: drop shell interpreters from the allowlist and run with no shell (or upgrade past the patched version)."
    },
    {
     "id": "t6",
     "text": "Block the attacker's source IP on the ops host's firewall."
    },
    {
     "id": "t7",
     "text": "Take the ops-assistant off every network the agent (or anyone) can reach, or disable run_command."
    },
    {
     "id": "t8",
     "text": "Rotate the deploy credential the server holds (OPSBOT_AWS_*), and review its recent use."
    }
   ],
   "key": "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"
  }
 ],
 "solution": "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",
 "inspiredBy": "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"
};
