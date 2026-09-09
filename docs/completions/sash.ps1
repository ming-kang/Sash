# PowerShell 7 native argument completion. Dot-source this file from your profile.
# Completion is local and static: it never executes Sash, npm, or a network request.
Register-ArgumentCompleter -Native -CommandName sash, sash.cmd, sash.ps1 -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commands = [ordered]@{
        start = 'Start management and Core'
        stop = 'Stop Sash and restore the prior proxy'
        restart = 'Apply saved configuration and restart Core'
        auto = 'Inspect or set login startup'
        status = 'Observe runtime state'
        doctor = 'Check installation and runtime diagnostics'
        profile = 'Manage saved profiles'
        proxy = 'Inspect or set the system proxy'
        mode = 'Change the running routing mode'
        logs = 'Read runtime logs'
        update = 'Update Core'
        upgrade = 'Upgrade Sash and restore its instances'
        web = 'Open the dashboard'
        version = 'Print the Sash version'
        help = 'Show command help'
    }
    $profiles = [ordered]@{
        list = 'List saved profiles'
        use = 'Select an exact profile ID or name for the next Apply'
        add = 'Download and save a remote profile'
        update = 'Update saved remote profiles'
        rename = 'Rename a saved profile'
        remove = 'Remove a saved profile'
        help = 'Show profile command help'
    }
    $flags = @{
        '' = @('-v', '--version')
        stop = @('--core')
        auto = @('--json')
        status = @('--json', '--watch', '--delay')
        doctor = @('--json')
        'profile list' = @('--json')
        'profile use' = @('--default', '--json')
        'profile add' = @('--name', '--use', '--json')
        'profile update' = @('--all', '--json')
        'profile rename' = @('--json')
        'profile remove' = @('--json')
        proxy = @('--json')
        mode = @('--json')
        logs = @('-n', '--lines', '-f', '--follow', '--errors', '--daemon', '--startup')
        update = @('--check', '--json')
        upgrade = @('--check', '--json')
        web = @('--no-open')
    }
    $descriptions = @{
        '--version' = 'Print the Sash version'
        '--help' = 'Show command help'
        '--core' = 'Stop Core and keep management available'
        '--json' = 'Output machine-readable JSON'
        '--watch' = 'Watch status changes; JSON uses one snapshot per line'
        '--delay' = 'Test an exact node or group name; watch samples every 30 seconds'
        '--default' = 'Select the built-in configuration'
        '--name' = 'Set the saved profile display name'
        '--use' = 'Select the new profile for the next Apply'
        '--all' = 'Update every remote profile'
        '--lines' = 'Number of log lines to print'
        '--follow' = 'Follow appended log output'
        '--errors' = 'Read stderr logs'
        '--daemon' = 'Read daemon logs'
        '--startup' = 'Read login startup diagnostics'
        '--check' = 'Check the release without installing or starting management'
        '--no-open' = 'Print the dashboard address without opening a browser'
    }
    $aliases = @{ '-v' = '--version'; '-h' = '--help'; '-n' = '--lines'; '-f' = '--follow' }
    $valueFlags = @('--delay', '--name', '--lines')
    $arguments = [System.Collections.Generic.List[string]]::new()
    foreach ($element in @($commandAst.CommandElements | Select-Object -Skip 1)) {
        if ($element.Extent.StartOffset -ge $cursorPosition) { break }
        if ($wordToComplete -and $element.Extent.EndOffset -ge $cursorPosition) { break }
        # Read literal AST values only. Never evaluate expressions in an unfinished command.
        if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $arguments.Add($element.Value)
        } else {
            $arguments.Add($element.Extent.Text)
        }
    }

    $command = ''
    $operands = [System.Collections.Generic.List[string]]::new()
    $used = @{}
    $needsValue = $false
    $endOptions = $false
    foreach ($argument in $arguments) {
        if ($needsValue) { $needsValue = $false; continue }
        if ($argument -eq '--') { $endOptions = $true; continue }
        if (-not $endOptions -and $argument.StartsWith('-')) {
            $flag = ($argument -split '=', 2)[0]
            if ($aliases.ContainsKey($flag)) { $flag = $aliases[$flag] }
            $used[$flag] = $true
            $needsValue = $valueFlags -contains $flag -and -not $argument.Contains('=')
            continue
        }
        if (-not $command) {
            if (-not $commands.Contains($argument)) { return }
            $command = $argument
        } elseif ($command -eq 'profile' -and $profiles.Contains($argument)) {
            $command = "profile $argument"
        } else {
            $operands.Add($argument)
        }
    }
    # Names, URLs, versions and counts are user input, not option positions.
    if ($needsValue -or $wordToComplete -match '^--[^=]+=') { return }
    $prefix = $wordToComplete -replace '^["'']', '' -replace '["'']$', ''
    $candidates = [ordered]@{}
    if ($command -eq '' -or ($command -eq 'help' -and $operands.Count -eq 0)) {
        foreach ($entry in $commands.GetEnumerator()) { $candidates[$entry.Key] = $entry.Value }
    } elseif ($command -eq 'profile' -or ($command -eq 'profile help' -and $operands.Count -eq 0)) {
        foreach ($entry in $profiles.GetEnumerator()) { $candidates[$entry.Key] = $entry.Value }
    } elseif ($operands.Count -eq 0 -and $command -in @('auto', 'proxy')) {
        $candidates['on'] = 'Enable'
        $candidates['off'] = 'Disable'
        $candidates['status'] = 'Inspect current state'
    } elseif ($operands.Count -eq 0 -and $command -eq 'mode') {
        $candidates['rule'] = 'Use routing rules'
        $candidates['global'] = 'Use the global outbound'
        $candidates['direct'] = 'Use direct connections'
    }
    if (-not $endOptions) {
        foreach ($flag in @('-h', '--help') + @($flags[$command])) {
            if (-not $flag) { continue }
            $canonical = if ($aliases.ContainsKey($flag)) { $aliases[$flag] } else { $flag }
            if ($used.ContainsKey($canonical)) { continue }
            if ($operands.Count -gt 0 -and (
                ($command -eq 'profile use' -and $flag -eq '--default') -or
                ($command -eq 'profile update' -and $flag -eq '--all')
            )) { continue }
            $candidates[$flag] = $descriptions[$canonical]
        }
    }
    foreach ($entry in $candidates.GetEnumerator()) {
        if (-not $entry.Key.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        $kind = if ($entry.Key.StartsWith('-')) { 'ParameterName' } else { 'ParameterValue' }
        [System.Management.Automation.CompletionResult]::new($entry.Key, $entry.Key, $kind, $entry.Value)
    }
}
