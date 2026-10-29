# TEGEL GAMES ARCADE

Welcome to the TEGEL games portal. This is a standalone PWA designed for high-speed neon gaming.

## Setup Instructions

### 1. Firebase (Path B)
- Create a NEW Firebase project at [console.firebase.google.com](https://console.firebase.google.com).
- Enable **Email/Password Authentication**.
- Create a **Realtime Database** (start in Locked Mode).
- Register a Web App and copy the config to your `.env` file (see `.env.example`).
- Go to **Auth > Settings > Authorized Domains** and add `games.tegelhus.uk`.

### 2. Local Development
```bash
npm install
npm run dev
```

### 3. Deploying
1. Create a new GitHub repository.
2. Add your Firebase keys to **GitHub Settings > Secrets > Actions**.
3. Push the code to the `main` branch.
4. Set the **Custom Domain** to `games.tegelhus.uk` in GitHub Settings.

## Project Structure
- `src/game.ts`: The core Canvas game loop.
- `src/firebase.ts`: Isolated database and auth logic.
- `src/style.scss`: Synthwave styles and flickering neon effects.
- `database.rules.json`: Security rules for high-scores.
