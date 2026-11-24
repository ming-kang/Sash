//go:build !helpercontract

package main

import ()

// installConsent publishes the release-pair through the shared Unix staged-install pipeline.
func (p *linuxPlatform) installConsent(src, sha, coreSrc string) (string, error) {
	return installConsentedPair(p.binDir, src, sha, coreSrc, linuxVerifyProtectedPath, publishJournal)
}
