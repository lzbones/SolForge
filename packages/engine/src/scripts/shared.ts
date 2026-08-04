/** Shared granted-ability implementations (cards granting abilities to others). */
import { registerGranted } from "./registry.js";
import { spawnCreature } from "../effects.js";

// "Vengeance: Spawn this" (e.g. granted by Keeper of the Damned)
registerGranted("shared:vengeance-spawn-self", {
  id: "shared:vengeance-spawn-self",
  trigger: "destroyed",
  resolve(ctx, self, evt) {
    spawnCreature(ctx.game, ctx.events, self.owner, self.defId, self.level, { lane: evt.lane ?? "random" });
  },
});
