import { createRoot } from "react-dom/client";
import "@fontsource-variable/sora";
import "@fontsource-variable/jetbrains-mono";
import { App } from "./App";
import "./styles.css";

// No StrictMode: its double-mounting in development would open two
// connections to the same room.
createRoot(document.getElementById("root")!).render(<App />);
