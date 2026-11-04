// What a seat that is not a Claude subagent sees. A Claude subagent reads the session files
// itself. Every other seat (an API call, a CLI call, a person's form) gets one assembled prompt:
// the round prompt, then only the session files that round allows, each under its own header.
// The rules are the spec's section 5. In particular, nobody sees another seat's Round 1 card
// before writing their own, and in Round 3 a seat sees only its own Round 2 card.
import fs from "node:fs";
import path from "node:path";
import { byKey, loadRoster, splitCards, systemText } from "./seats.mjs";

export const CARD_ONLY = "Reply with the card only, in the exact field format above. No preamble and no closing remarks.";

// "round-2.md#own" is not a file name: it means the seat's own card from round-2.md.
const OWN_ROUND_2 = "round-2.md#own";
const CONTEXT = {
  1: ["brief.md"],
  2: ["brief.md", "round-1.md", "cruxes.json"],
  3: ["brief.md", OWN_ROUND_2, "draft-resolution.md"],
};

/** The session files a round may show, in order. An unknown round throws: sending a seat
 * less than the round allows would look the same as sending it everything. */
export function contextFiles(round) {
  if (!Object.hasOwn(CONTEXT, String(round))) throw new RangeError(`round must be 1, 2 or 3, not ${String(round)}`);
  return CONTEXT[round].slice();
}

const readIfThere = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null; // missing is skipped; any other failure is a real problem
    throw e;
  }
};

/** The context items for one seat and round: [{ name, text }]. A file that is not there is
 * left out. The text is the file as written. */
export function readContext(sessionDir, round, seatKey) {
  const out = [];
  for (const name of contextFiles(round)) {
    if (name === OWN_ROUND_2) {
      const md = readIfThere(path.join(sessionDir, "round-2.md"));
      const own = md === null ? undefined : splitCards(md).find((c) => c.key === seatKey);
      if (own) out.push({ name: "Your Round 2 card", text: own.text });
      continue;
    }
    const text = readIfThere(path.join(sessionDir, name));
    if (text !== null) out.push({ name, text });
  }
  return out;
}

/** The user message: the prompt, each context item under a header, then the card-only line. */
export function buildUser({ promptText, context = [], cardOnly = true }) {
  const items = context.map((c) => `\n\n===== ${c.name} =====\n${c.text}`).join("");
  return `${promptText}${items}${cardOnly ? `\n\n${CARD_ONLY}` : ""}`;
}

/** Everything a non-subagent seat is sent. `files` names the context items actually attached,
 * so a dry run can show what would leave the machine. A consult (a question to one seat, no
 * round) attaches nothing and does not ask for a card. */
export function buildSeatCall({ sessionDir, seatKey, round, promptText, consult = false }) {
  loadRoster(); // a seat added since the process started
  if (!Object.hasOwn(byKey, seatKey)) throw new Error(`Unknown seat: ${String(seatKey)}`);
  const context = consult ? [] : readContext(sessionDir, round, seatKey);
  return {
    system: systemText(seatKey),
    user: buildUser({ promptText, context, cardOnly: !consult }),
    files: context.map((c) => c.name),
  };
}
