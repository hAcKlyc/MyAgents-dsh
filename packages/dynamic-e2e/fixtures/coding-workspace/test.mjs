import assert from "node:assert/strict";
import { greeting } from "./greeting.mjs";

assert.equal(greeting("Ada"), "Hello, Ada!");
