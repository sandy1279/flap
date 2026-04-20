# 🧠 Local MCP Agent

A fully local AI agent that controls your PC using natural language.  
Runs entirely on your machine — no cloud, no API keys, no data leaving your device.

## 🚀 Features
- Fully local (Ollama)
- Tool calling with structured APIs
- Modular MCP architecture
- Sandboxed file access
- JSON persistence

## ⚙️ Setup

### Requirements
- Node.js 18+
- Ollama

### Install model
ollama pull qwen3:8b

### Build
cd tools
npm install
npm run build

cd ../agent
npm install
npm run build

### Run
node dist/agent.js
