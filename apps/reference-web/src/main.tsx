import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { ReferenceWebStore } from "./store.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Reference Web root element is unavailable");

createRoot(root).render(<StrictMode><App store={new ReferenceWebStore()} /></StrictMode>);
