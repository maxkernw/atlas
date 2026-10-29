import './style.scss';
import { registerSW } from 'virtual:pwa-register';
import { subscribeToLeaderboard, submitScore } from './firebase';
import { Game } from './game';

registerSW({ immediate: true });

const appDiv = document.querySelector<HTMLDivElement>('#app')!;

function hideSplashScreen() {
    const splash = document.getElementById('splash-screen');
    if (splash) {
        splash.classList.add('fade-out');
        setTimeout(() => splash.remove(), 1500);
    }
}

if (!import.meta.env.VITE_FIREBASE_API_KEY) {
    console.warn("FIREBASE API KEY MISSING! Check your .env file.");
}

export function showCustomConfirm(title: string, message: string, onConfirm: () => void) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay-custom';
    modal.innerHTML = `
        <div class="modal-content-custom">
            <h2 class="retro-font" style="color: #7ce8ff; margin-top: 0; font-size: 1.1rem; line-height: 1.5; font-weight: 400;">${title}</h2>
            <p style="color: rgba(235, 248, 255, 0.8); margin-bottom: 24px; font-size: 0.95rem; line-height: 1.5; letter-spacing: 0.08em;">${message}</p>
            <div style="display: flex; gap: 15px; justify-content: center;">
                <button id="modal-yes" class="neon-btn-custom">CONFIRM</button>
                <button id="modal-no" class="neon-btn-custom abort">RESUME FLIGHT</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    document.getElementById('modal-yes')?.addEventListener('click', () => {
        onConfirm();
        modal.remove();
    });
    document.getElementById('modal-no')?.addEventListener('click', () => modal.remove());
}

export function showCustomPrompt(title: string, message: string, defaultValue: string, onConfirm: (val: string) => void) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay-custom';
    modal.innerHTML = `
        <div class="modal-content-custom">
            <h2 class="retro-font" style="color: #7ce8ff; margin-top: 0; font-size: 1.1rem; line-height: 1.5; font-weight: 400;">${title}</h2>
            <p style="color: rgba(235, 248, 255, 0.8); margin-bottom: 18px; font-size: 0.9rem; line-height: 1.5; letter-spacing: 0.1em;">${message}</p>
            <input type="text" id="modal-input" value="${defaultValue}" class="neon-input-custom" maxlength="12" />
            <div style="margin-top: 24px; display: flex; gap: 12px; justify-content: center;">
                <button id="modal-submit" class="neon-btn-custom">TRANSMIT TO ATLAS</button>
                <button id="modal-cancel" class="neon-btn-custom abort">CONTINUE</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const input = document.getElementById('modal-input') as HTMLInputElement;
    input.focus();
    input.select();

    const handleSubmit = () => {
        onConfirm(input.value);
        modal.remove();
    };

    document.getElementById('modal-submit')?.addEventListener('click', handleSubmit);
    document.getElementById('modal-cancel')?.addEventListener('click', () => modal.remove());
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSubmit();
    });
}

let currentGame: Game | null = null;

function renderArcade() {
    if (currentGame) {
        currentGame.destroy();
        currentGame = null;
    }
    
    appDiv.innerHTML = `
        <div id="game-container"></div>
        <div class="leaderboard-overlay">
            <h3 class="retro-font">ATLAS REGISTRY</h3>
            <div id="scores-list" style="font-size: 0.85rem; line-height: 1.9; letter-spacing: 0.08em;"></div>
        </div>
        <button id="logout-btn">❖ UPLOAD DISCOVERIES</button>
    `;

    const handleUploadScore = (finalScore: number) => {
        const defaultName = currentGame ? currentGame.getPilotCallsign() : "TRAVELLER";
        showCustomPrompt("ATLAS DISCOVERY LOG", `TRANSMIT ${finalScore.toLocaleString()} DISCOVERY UNITS TO REGISTRY`, defaultName, async (username) => {
            const finalUsername = (username || defaultName).substring(0, 12).toUpperCase();
            try {
                await submitScore({
                    username: finalUsername,
                    score: finalScore,
                    timestamp: Date.now()
                });
            } catch (e) {
                console.warn("Could not upload score to Firebase:", e);
            }
        });
    };

    const gameContainer = document.getElementById('game-container')!;
    currentGame = new Game(gameContainer, (finalScore) => {
        handleUploadScore(finalScore);
    });

    document.getElementById('logout-btn')?.addEventListener('click', () => {
        if (currentGame) {
            handleUploadScore(currentGame.getScore());
        }
    });

    subscribeToLeaderboard((scores) => {
        const list = document.getElementById('scores-list');
        if (!list) return;
        list.innerHTML = scores.map(s => `
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: rgba(255,255,255,0.85);">${s.username}</span>
                <span style="color: #ffbe6b; font-weight: 600;">${s.score.toLocaleString()}</span>
            </div>
        `).join('');

        if (currentGame && scores.length > 0) {
            const uniquePilots = Array.from(new Set(scores.map(s => s.username).filter(Boolean)));
            currentGame.setLeaderboardPilots(uniquePilots);
        }
    });
}

try {
    renderArcade();
} catch (err) {
    console.error("Failed to render expedition:", err);
    appDiv.innerHTML = `<div style="color: #ff7e6b; padding: 20px;">ATLAS TELEMETRY ERROR: CHECK CONSOLE.</div>`;
} finally {
    setTimeout(hideSplashScreen, 1500);
}
