import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

// Firebase config (public). Use env vars later if desired.
export const firebaseConfig = {
  apiKey: "AIzaSyANmvWGm-Y3V2qeQlwbQZVTwpvFHG_MSm0",
  authDomain: "supplysys-2025.firebaseapp.com",
  projectId: "supplysys-2025",
  storageBucket: "supplysys-2025.firebasestorage.app",
  messagingSenderId: "116513264770",
  appId: "1:116513264770:web:a1923cb82ec147a1be109b"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);
