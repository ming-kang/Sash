import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tunPrivilegeGuidance } from "./tun-guidance.js";

describe("tunPrivilegeGuidance", () => {
  it("gives the complete Windows recovery flow after activation rolls back", () => {
    const message = tunPrivilegeGuidance("activation-rolled-back", {
      platform: "win32",
      root: "C:\\Users\\Asterin\\Sash",
    });

    assert.match(message, /sash config set tun on/);
    assert.match(message, /PowerShell as Administrator/);
    assert.match(message, /run "sash restart"/);
    assert.match(message, /If SASH_HOME was explicitly customized/);
    assert.doesNotMatch(message, /\$env:SASH_HOME/);
    assert.doesNotMatch(message, /sash stop/);
  });

  it("points at an elevated full restart when the runtime is inactive", () => {
    const message = tunPrivilegeGuidance("runtime-inactive", {
      platform: "win32",
      root: "C:\\Sash",
    });

    assert.match(message, /PowerShell as Administrator/);
    assert.match(message, /run "sash restart"/);
    assert.doesNotMatch(message, /sash config set tun on/);
  });

  it("keeps non-Windows guidance platform-neutral", () => {
    const message = tunPrivilegeGuidance("runtime-inactive", {
      platform: "linux",
      root: "/home/user's/Sash Data",
    });

    assert.match(message, /root privileges/);
    assert.ok(
      message.includes(
        "sudo env SASH_HOME='/home/user'\\''s/Sash Data' \"$(command -v sash)\" restart",
      ),
    );
    assert.doesNotMatch(message, /PowerShell/);
  });
});
