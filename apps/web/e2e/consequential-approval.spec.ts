import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("consequential actions expose every approval state and standing rules", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `consequential-approval-${stamp}@rakazo.test`, "password12", "Approval UI");
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);

  await requestDestinationWrite(page);
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Always allow this tool" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
  await captureScreenshot(page, testInfo, "50-consequential-approval-pending");

  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("Denied", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await captureScreenshot(page, testInfo, "51-consequential-approval-denied");

  await requestDestinationWrite(page);
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText("Allowed once", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await captureScreenshot(page, testInfo, "52-consequential-approval-allowed-once");

  await requestDestinationWrite(page);
  await page.getByRole("button", { name: "Always allow this tool" }).click();
  await expect(page.getByText("Always allowed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await captureScreenshot(page, testInfo, "53-consequential-approval-always-allowed");

  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  const approvalsHeading = settings.getByRole("heading", { name: "Action approvals" });
  await approvalsHeading.scrollIntoViewIfNeeded();
  await expect(settings.getByText("Always allow destination.write", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Require approval before external email" }).click();
  const emailRule = settings.getByText("Require approval for email actions", { exact: true });
  await expect(emailRule).toBeVisible();
  await emailRule.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "54-consequential-approval-rules");
});

async function requestDestinationWrite(page: Page) {
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("write this to the destination crm as a note");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible({
    timeout: 30_000,
  });
}
