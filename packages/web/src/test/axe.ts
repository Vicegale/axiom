import axe from "axe-core";
import { expect } from "vitest";

/**
 * Runs axe-core on the rendered page. Colour contrast needs real layout and painting, so it is
 * off here and is checked from the token pairs and in a real browser instead.
 */
export async function expectAccessible(root: Element = document.body): Promise<void> {
  const results = await axe.run(root, {
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"],
  });
  const report = results.violations
    .map(
      (v) => `${v.id}: ${v.help}\n${v.nodes.map((n) => `    ${n.html.slice(0, 200)}`).join("\n")}`,
    )
    .join("\n");
  expect(results.violations, report).toEqual([]);
}
