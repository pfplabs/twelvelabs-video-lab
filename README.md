# twelvelabs-video-lab

My own video AI lab: Jockey -> managed search -> Pegasus -> Marengo -> Bedrock.

## Setup (Node.js 20+, default path)
npm install
cp .env.example .env   # add my own TwelveLabs key locally; never commit .env

## Setup (Python 3.10+, alternative path)
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env

## Rules
- Only my own recordings go in media/ (gitignored).
- Remote IDs live in state.json (gitignored) so runs resume.
- Run git status and git diff --cached before every commit.