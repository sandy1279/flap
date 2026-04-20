Local MCP Agent
A fully local AI agent that controls your PC using natural language. Runs entirely on your machine — no cloud, no API keys, no data leaving your device.

Architecture
┌─────────────────────────────────────────────────────┐
│                    You (terminal)                   │
└────────────────────────┬────────────────────────────┘
                         │ natural language
                         ▼
┌─────────────────────────────────────────────────────┐
│              agent/src/agent.ts  (Client)           │
│                                                     │
│  • Manages conversation history                     │
│  • Calls Ollama /api/chat with native tools API     │
│  • Receives tool_calls or content from model        │
│  • Executes tools via MCP client                    │
│  • Loops until model gives a final text reply       │
└───────────────┬─────────────────┬───────────────────┘
                │ HTTP            │ stdio (MCP)
                ▼                 ▼
┌───────────────────┐   ┌─────────────────────────────┐
│  Ollama           │   │  tools/src/index.ts          │
│  (local LLM)      │   │  (MCP Tool Server)           │
│                   │   │                              │
│  mistral:7b       │   │  Exposes ~25 tools over MCP  │
│  llama3.1         │   │  Sandboxed file access       │
│  qwen3:8b         │   │  Cross-platform (Win/Mac/Lin)│
│  etc.             │   │  JSON persistence store      │
└───────────────────┘   └─────────────────────────────┘
How a request flows

You type a message in the terminal
Agent sends it to Ollama with all tool definitions attached
Ollama returns either:

tool_calls → agent executes each tool via MCP, feeds results back, loops
content → plain text final answer, printed to terminal


Tool results are injected as role: "tool" messages so the model can reason over them
The loop continues until the model stops calling tools

Key design decisions
Native Ollama tools API — tools are passed as structured JSON schemas, not described in the system prompt. The model returns structured tool_calls objects, not freeform text. This works reliably across all supported models.
MCP (Model Context Protocol) — the tool server is a separate Node.js process communicating over stdio. This keeps tools isolated from the agent and makes it easy to add/remove tools without touching the agent.
Path sandbox — all file operations are restricted to MCP_ALLOWED_ROOTS. Any path outside those roots is rejected before touching the filesystem.
JSON persistence — tasks, notes, and reminders are stored as flat JSON files in ~/.mcp-agent/. No database needed.

Tools
System
ToolWhat it doessystem_infoHardware, OS, memory, uptimelist_processesRunning processes sorted by CPUrun_shell_commandExecute a shell command (sandboxed)lock_pcLock the workstation (Windows)
Apps & Browser
ToolWhat it doesopen_appLaunch any applicationclose_appForce-kill a processfind_appLocate an installed exe (Windows)open_urlOpen a URL in the default browserbrowser_searchGoogle search in default browsersend_emailOpen mail client with prefilled draft
YouTube
ToolWhat it doesyoutube_playSearch and immediately play a video/songyoutube_searchSearch and return results without opening browser
Files
ToolWhat it doeslist_dirList directory contents with sizessearch_filesRecursive filename searchread_fileRead file contents (paginated for large files)write_fileWrite/overwrite a fileappend_fileAppend to a filemove_fileMove or renamecopy_fileCopy a filedelete_fileDelete a fileorganize_folderSort files into subfolders by extension
Clipboard
ToolWhat it doesclipboard_getRead clipboard textclipboard_setWrite text to clipboard
Productivity
ToolWhat it doescreate_taskCreate a to-do with prioritylist_tasksList tasks filtered by statuscomplete_taskMark a task donedelete_taskDelete a taskcreate_noteCreate a note with tagslist_notesList notes (filter by tag)read_noteRead a note's full contentsearch_notesKeyword search across all notesdelete_noteDelete a noteset_reminderSave a reminder with a datetimelist_remindersList upcoming or all reminderscomplete_reminderMark a reminder donedelete_reminderDelete a reminder

Use Cases
Daily productivity
"remind me to call John tomorrow at 9am"
"create a high priority task: submit report"
"list my todo tasks"
"make a note titled Meeting Notes with ..."
PC control
"open spotify"
"close chrome"
"lock my pc"
"what processes are using the most CPU?"
Files
"organize my downloads folder"
"search for any file named resume in my documents"
"read the file C:\Users\me\notes.txt"
"copy config.json to D:\backup"
Media
"play Lose Yourself by Eminem on YouTube"
"search YouTube for lo-fi study music"
Browser & email
"search google for best python libraries 2025"
"open github.com"
"draft an email to john@example.com about the meeting"

Setup
Requirements

Node.js 18+
Ollama running locally

Install a model
bash# Recommended (best tool-calling reliability)
ollama pull qwen3:8b

# Lighter option
ollama pull mistral:7b-instruct
Install dependencies & build
bash# Build the MCP tool server
cd tools
npm install
npm run build

# Build the agent client
cd ../agent   # or wherever agent.ts lives
npm install
npm run build
Run
bashnode dist/agent.js
Environment variables
bashOLLAMA_MODEL=qwen3:8b          # model to use (default: mistral:7b-instruct)
OLLAMA_ENDPOINT=http://127.0.0.1:11434  # ollama URL (default)
OLLAMA_TIMEOUT=120000          # request timeout in ms (default: 120s)
MAX_TOOL_LOOPS=10              # max tool calls per turn (default: 10)
MCP_DATA_DIR=~/.mcp-agent      # where tasks/notes/reminders are stored
MCP_ALLOWED_ROOTS=/home/me     # colon-separated (Unix) or semicolon (Windows)
                               # directories the agent can read/write

Project Structure
├── agent/
│   └── src/
│       └── agent.ts        # Agent client — Ollama + MCP loop
└── tools/
    └── src/
        └── index.ts        # MCP tool server — all tool implementations

Recommended Models (Ollama)
ModelSizeTool callingNotesqwen3:8b~5 GB⭐⭐⭐⭐⭐Best overall, Ollama's own examples use itmistral:7b-instruct~4 GB⭐⭐⭐⭐Lighter, good reliabilityllama3.1:8b~5 GB⭐⭐⭐⭐Meta's model, solidqwen2.5:7b~4 GB⭐⭐⭐⭐Stable alternative to qwen3
Switch models anytime:
bashOLLAMA_MODEL=qwen3:8b node dist/agent.js

Security

File tools are sandboxed to MCP_ALLOWED_ROOTS — paths outside are rejected
Shell commands run with your user permissions — don't run untrusted input
All data stays local — nothing is sent to any external service
Clipboard writes go via temp file, never string-interpolated into shell scripts