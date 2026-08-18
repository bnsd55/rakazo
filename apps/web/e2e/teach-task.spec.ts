import { test, expect } from "@playwright/test";
import { activeBotId, completeOnboarding, signup } from "./helpers";

test("teach a task records interaction and saves a draft", async ({ page }) => {
  await signup(page);
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await page.getByTitle("Agent computer").click();
  await page.getByTestId("teach-start-button").click();
  await page.getByTestId("teach-goal-input").fill("Export weekly CRM list");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByTestId("teach-recording")).toBeVisible();
  await expect(page.getByText("Open in full window")).toBeVisible();
  await page.getByLabel("Open computer").click();
  const overlay = page.getByTestId("teach-capture-overlay");
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  if (!box) throw new Error("missing overlay box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type("demo");
  await page.getByRole("button", { name: "Stop teaching" }).click();
  await expect(page.getByTestId("skill-draft-card")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 10_000 });
});
