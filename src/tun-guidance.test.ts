import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tunPrivilegeGuidance } from "./tun-guidance.js";

describe("tunPrivilegeGuidance", () => {
  it("gives the complete Windows recovery flow after activation rolls back", () => {
    const message = tunPrivilegeGuidance("activation-rolled-back", {
      platform: "win32",
      root: "C:\\Users\\Asterin\\Sash",
    });

    assert.match(message, /sash stop/);
    assert.match(message, /PowerShell as Administrator/);
    assert.match(message, /sash config set tun on/);
    assert.match(message, /run "sash start"/);
    assert.match(message, /If SASH_HOME was explicitly customized/);
    assert.doesNotMatch(message, /\$env:SASH_HOME/);
  });

  it("warns that restarting only the Core cannot elevate sashd", () => {
    const message = tunPrivilegeGuidance("runtime-inactive", {
      platform: "win32",
      root: "C:\\Sash",
    });

    assert.match(message, /sash restart.*alone does not elevate sashd/);
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
        "sudo env SASH_HOME='/home/user'\\''s/Sash Data' \"$(command -v sash)\" start",
      ),
    );
    assert.doesNotMatch(message, /PowerShell/);
  });
});
