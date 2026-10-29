import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit } from "firebase/firestore";

// Replace with YOUR NEW PROJECT (Path B) config from Firebase Console
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

export interface HighScore {
    username: string;
    score: number;
    timestamp: number;
}

export async function submitScore(score: HighScore) {
    return addDoc(collection(db, 'highscores'), score);
}

export function subscribeToLeaderboard(callback: (scores: HighScore[]) => void) {
    const q = query(
        collection(db, 'highscores'), 
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
