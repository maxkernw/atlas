import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit } from "firebase/firestore";
import {
    getDatabase,
    ref,
    set,
    push,
    remove,
    onValue,
    onChildAdded,
    onDisconnect,
    query as rtdbQuery,
    limitToLast,
    type Database
} from "firebase/database";

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

let rtdb: Database | null = null;
try {
    if (import.meta.env.VITE_FIREBASE_DATABASE_URL) {
        rtdb = getDatabase(app);
    } else {
        console.warn("VITE_FIREBASE_DATABASE_URL not set; Realtime Database multiplayer disabled.");
    }
} catch (err) {
    console.warn("Could not initialize Firebase Realtime Database:", err);
}

export interface HighScore {
    username: string;
    score: number;
    timestamp: number;
}

export interface OnlinePlayerState {
    id: string;
    callsign: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
    roll: number;
    pitch: number;
    hull: number;
    colorHex: number;
    hullPresetIdx: number;
    chassisIdx: number;
    isCustomizing: boolean;
    updatedAt: number;
}

export interface PersistedChatMessage {
    id?: string;
    sender: string;
    colorHex: number;
    text: string;
    isSystem?: boolean;
    timestamp: number;
}

export interface CombatHitEvent {
    attackerId: string;
    attackerCallsign: string;
    damage: number;
    timestamp: number;
}

const ATLAS_COLLECTION = 'atlas';

export async function submitScore(score: HighScore) {
    return addDoc(collection(db, ATLAS_COLLECTION), score);
}

export function subscribeToLeaderboard(callback: (scores: HighScore[]) => void) {
    const q = query(
        collection(db, ATLAS_COLLECTION),
        orderBy('score', 'desc'),
        limit(10)
    );

    return onSnapshot(q, (snapshot) => {
        const scores = snapshot.docs.map(doc => doc.data() as HighScore);
        callback(scores);
    }, (error) => {
        console.error("Leaderboard subscription error:", error);
    });
}

// ============================================================================
// FIREBASE REALTIME DATABASE: ONLINE PLAYERS, PERSISTED CHAT & PVP COMBAT
// ============================================================================

export function registerOnlinePlayer(playerId: string, initialState: OnlinePlayerState): () => void {
    if (!rtdb) return () => {};
    const playerRef = ref(rtdb, `atlas_players/${playerId}`);
    onDisconnect(playerRef).remove().catch(() => {});
    set(playerRef, initialState).catch((err) => {
        console.warn("Failed to register online player in RTDB:", err);
    });

    const handleUnload = () => {
        remove(playerRef).catch(() => {});
    };
    window.addEventListener('beforeunload', handleUnload);

    return () => {
        window.removeEventListener('beforeunload', handleUnload);
        remove(playerRef).catch(() => {});
    };
}

export function syncOnlinePlayerState(playerId: string, state: OnlinePlayerState) {
    if (!rtdb) return;
    const playerRef = ref(rtdb, `atlas_players/${playerId}`);
    set(playerRef, state).catch(() => {});
}

export function subscribeToOnlinePlayers(
    localPlayerId: string,
    onUpdate: (players: Record<string, OnlinePlayerState>) => void
): () => void {
    if (!rtdb) return () => {};
    const playersRef = ref(rtdb, 'atlas_players');
    const unsubscribe = onValue(playersRef, (snapshot) => {
        const raw = (snapshot.val() || {}) as Record<string, OnlinePlayerState>;
        const now = Date.now();
        const active: Record<string, OnlinePlayerState> = {};
        for (const [id, p] of Object.entries(raw)) {
            if (!p || id === localPlayerId) continue;
            // Filter out ghost sessions that haven't updated in > 65 seconds
            if (now - (p.updatedAt || 0) < 65000) {
                active[id] = p;
            }
        }
        onUpdate(active);
    }, (err) => {
        console.warn("Online players subscription error:", err);
    });
    return unsubscribe;
}

export function pushPersistedChatMessage(msg: Omit<PersistedChatMessage, 'id'>) {
    if (!rtdb) return;
    const chatRef = ref(rtdb, 'atlas_chat');
    push(chatRef, msg).catch((err) => {
        console.warn("Failed to push chat message to RTDB:", err);
    });
}

export function subscribeToPersistedChat(
    onMessage: (msg: PersistedChatMessage) => void
): () => void {
    if (!rtdb) return () => {};
    // Firebase push keys are chronologically ordered by default; using limitToLast without orderByChild
    // avoids requiring ".indexOn": ["timestamp"] in Firebase Realtime Database security rules.
    const recentChatQuery = rtdbQuery(
        ref(rtdb, 'atlas_chat'),
        limitToLast(25)
    );
    const unsubscribe = onChildAdded(recentChatQuery, (snapshot) => {
        const val = snapshot.val() as PersistedChatMessage | null;
        if (val && val.text) {
            onMessage({
                ...val,
                id: snapshot.key || undefined
            });
        }
    }, (err) => {
        console.warn("Chat subscription error:", err);
    });
    return unsubscribe;
}

export function sendPvPCombatHit(targetPlayerId: string, hit: CombatHitEvent) {
    if (!rtdb) return;
    const hitRef = ref(rtdb, `atlas_combat/${targetPlayerId}`);
    push(hitRef, hit).catch(() => {});
}

export function subscribeToIncomingCombatHits(
    localPlayerId: string,
    onHit: (hit: CombatHitEvent) => void
): () => void {
    if (!rtdb) return () => {};
    const myHitsRef = ref(rtdb, `atlas_combat/${localPlayerId}`);
    const startTime = Date.now();
    const unsubscribe = onChildAdded(myHitsRef, (snapshot) => {
        const val = snapshot.val() as CombatHitEvent | null;
        if (val && val.timestamp >= startTime - 2000) {
            onHit(val);
        }
        // Clean up processed hit event immediately
        if (snapshot.key && rtdb) {
            remove(ref(rtdb, `atlas_combat/${localPlayerId}/${snapshot.key}`)).catch(() => {});
        }
    });
    return unsubscribe;
}
