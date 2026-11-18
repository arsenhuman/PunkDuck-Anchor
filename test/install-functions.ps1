# Tests for the pure functions in packaging/install.ps1. Windows PowerShell 5.1, no modules needed:
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\install-functions.ps1
# Only the function definitions are loaded (through the AST), so nothing in the install flow runs.
# Keep this file pure ASCII.

$ErrorActionPreference = 'Stop'
$script:Failures = 0
$script:Count = 0

function Assert-True([bool]$Condition, [string]$Message) {
    $script:Count++
    if (-not $Condition) {
        $script:Failures++
        Write-Host "FAIL: $Message" -ForegroundColor Red
    }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    Assert-True ($Expected -eq $Actual) "$Message (expected '$Expected', got '$Actual')"
}

$installPs1 = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'packaging') 'install.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installPs1, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "install.ps1 does not parse: $($errors[0].Message)" }

$functions = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($f in $functions) { . ([scriptblock]::Create($f.Extent.Text)) }

# ---- Test-LocalSqlHost ----
foreach ($h in @('localhost', 'LOCALHOST', '127.0.0.1', '::1', '.', '(local)', '(LOCAL)', 'sql-box01', 'SQL-BOX01', ' localhost ')) {
    Assert-True (Test-LocalSqlHost $h 'SQL-BOX01') "Test-LocalSqlHost '$h' should be local"
}
foreach ($h in @('sqlbox', '10.0.0.5', 'sql-box01.corp', '')) {
    Assert-True (-not (Test-LocalSqlHost $h 'SQL-BOX01')) "Test-LocalSqlHost '$h' should not be local"
}
Assert-True (-not (Test-LocalSqlHost 'x' '')) 'no computer name: only the fixed names are local'

# ---- Resolve-SqlInstance ----
$i = Resolve-SqlInstance '' '1433'
Assert-Equal 'MSSQLSERVER' $i.ServiceName 'default instance service'
Assert-Equal 'lpc:.' $i.DataSource 'default instance data source'
Assert-Equal 'MSSQLSERVER' $i.InstanceName 'default instance WMI name'
Assert-True (-not $i.IsNamed) 'default instance is not named'
Assert-True (-not $i.NeedsBrowser) 'default instance needs no Browser'

$i = Resolve-SqlInstance ' SQLEXPRESS ' ''
Assert-Equal 'MSSQL$SQLEXPRESS' $i.ServiceName 'named instance service'
Assert-Equal 'lpc:.\SQLEXPRESS' $i.DataSource 'named instance data source'
Assert-Equal 'SQLEXPRESS' $i.InstanceName 'named instance WMI name'
Assert-True $i.IsNamed 'named instance'
Assert-True $i.NeedsBrowser 'named instance, empty SQL_PORT: Browser needed'
Assert-True (Resolve-SqlInstance 'SQLEXPRESS' '1433').NeedsBrowser 'named instance, SQL_PORT 1433: Browser needed'
Assert-True (-not (Resolve-SqlInstance 'SQLEXPRESS' '49172').NeedsBrowser) 'named instance, fixed SQL_PORT: no Browser'

# ---- Test-SqlLoginName ----
Assert-True (Test-SqlLoginName 'backup_user') 'plain login name is valid'
Assert-True (Test-SqlLoginName "we]ird o'name") 'brackets and quotes are allowed (QUOTENAME handles them)'
Assert-True (-not (Test-SqlLoginName '')) 'empty login name is invalid'
Assert-True (-not (Test-SqlLoginName 'CORP\backup')) 'DOMAIN\user is invalid'
Assert-True (-not (Test-SqlLoginName ('a' * 129))) '129 characters is invalid'
Assert-True (-not (Test-SqlLoginName "a`tb")) 'control characters are invalid'

# ---- Split-DatabaseList ----
$dbs = Split-DatabaseList ' Sales, HR ,,'
Assert-Equal 2 $dbs.Count 'two databases'
Assert-Equal 'HR' $dbs[1] 'trimmed name'
Assert-Equal 0 (Split-DatabaseList '').Count 'empty list'

# ---- Test-SupportedWindows ----
Assert-True (Test-SupportedWindows 10 19045 1 'AMD64') 'Windows 10 x64'
Assert-True (Test-SupportedWindows 10 22631 1 'AMD64') 'Windows 11 x64'
Assert-True (Test-SupportedWindows 10 14393 3 'AMD64') 'Windows Server 2016'
Assert-True (Test-SupportedWindows 10 26100 3 'AMD64') 'Windows Server 2025'
Assert-True (Test-SupportedWindows 10 17763 2 'AMD64') 'Windows Server 2019 domain controller'
Assert-True (-not (Test-SupportedWindows 6 9600 3 'AMD64')) 'Windows Server 2012 R2 is not supported (Node 22)'
Assert-True (-not (Test-SupportedWindows 10 10240 3 'AMD64')) 'server build before 2016 is not supported'
Assert-True (-not (Test-SupportedWindows 10 19045 1 'x86')) '32-bit is not supported'
Assert-True (-not (Test-SupportedWindows 10 22631 1 'ARM64')) 'ARM64 is not supported'

# ---- Get-SqlLoginPlan ----
$p = Get-SqlLoginPlan 'backup_user' $false $false
Assert-Equal 'create' $p.Action 'both empty (default name), no login: create'
Assert-True $p.GeneratePassword 'both empty: generated password'
$p = Get-SqlLoginPlan 'app_backup' $true $false
Assert-Equal 'create' $p.Action 'given user + password, no login: create'
Assert-True (-not $p.GeneratePassword) 'given password is used, not generated'
Assert-True (Get-SqlLoginPlan 'app_backup' $false $false).GeneratePassword 'given user, no password, no login: generated password'
Assert-Equal 'use' (Get-SqlLoginPlan 'app_backup' $true $true).Action 'existing login with password: use it unchanged'
Assert-Equal 'use' (Get-SqlLoginPlan 'backup_user' $true $true).Action 'default login with password: use it'
Assert-Equal 'reset' (Get-SqlLoginPlan 'backup_user' $false $true).Action 'own default login without password: reset'
$p = Get-SqlLoginPlan 'sa' $false $true
Assert-Equal 'error' $p.Action 'existing foreign login without password: never reset its password'
Assert-True ($p.Message -match 'SQL_PASSWORD') 'error names SQL_PASSWORD'

# ---- New-SqlLoginPassword ----
$seen = @{}
for ($n = 0; $n -lt 1000; $n++) {
    $pw = New-SqlLoginPassword
    if ($pw.Length -ne 32) { Assert-True $false "password length $($pw.Length)"; break }
    if ($pw -cnotmatch '^[A-Za-z0-9]{32}$') { Assert-True $false "password charset: $pw"; break }
    if ($pw -cnotmatch '[A-Z]' -or $pw -cnotmatch '[a-z]' -or $pw -notmatch '[0-9]') { Assert-True $false "password classes: $pw"; break }
    $seen[$pw] = $true
}
Assert-Equal 1000 $seen.Count '1000 distinct valid passwords'
Assert-Equal 8 (New-SqlLoginPassword 8).Length 'custom length'

# ---- Select-SqlWmiNamespace ----
$ns = @(Select-SqlWmiNamespace @('ServerEvents', 'ComputerManagement13', 'ComputerManagement17', 'ComputerManagement15'))
Assert-Equal 3 $ns.Count 'all ComputerManagement namespaces'
Assert-Equal 'root\Microsoft\SqlServer\ComputerManagement17' $ns[0] 'newest first'
Assert-Equal 'root\Microsoft\SqlServer\ComputerManagement15' $ns[1] 'then the next'
Assert-Equal 'root\Microsoft\SqlServer\ComputerManagement13' $ns[2] 'oldest last'
Assert-Equal 2 @(Select-SqlWmiNamespace @('ComputerManagement9', 'ComputerManagement13')).Count 'numeric, not text, order'
Assert-Equal 'root\Microsoft\SqlServer\ComputerManagement13' @(Select-SqlWmiNamespace @('ComputerManagement9', 'ComputerManagement13'))[0] '13 is newer than 9'
Assert-Equal 0 @(Select-SqlWmiNamespace @('ServerEvents')).Count 'no ComputerManagement namespace'
Assert-Equal 0 @(Select-SqlWmiNamespace @()).Count 'no namespaces'

# ---- Get-TcpPortPlan ----
$p = Get-TcpPortPlan '' '1433'
Assert-Equal 'set' $p.Action 'no static port: set it'
Assert-Equal '1433' $p.Port 'set SQL_PORT'
Assert-Equal '1433' (Get-TcpPortPlan '' '').Port 'empty SQL_PORT means 1433'
Assert-Equal 'keep' (Get-TcpPortPlan '1433' '1433').Action 'same port: keep'
Assert-Equal 'keep' (Get-TcpPortPlan '1500, 1433' '1433').Action 'SQL_PORT among several ports: keep'
$p = Get-TcpPortPlan '1500' '1433'
Assert-Equal 'adopt' $p.Action 'other static port: adopt'
Assert-Equal '1500' $p.Port 'adopt the configured port'

# ---- Format-EnvValue / Set-EnvValue / Get-EnvValue ----
Assert-Equal 'C:\SQL\Backup' (Format-EnvValue 'C:\SQL\Backup') 'plain value stays unquoted'
Assert-Equal "'D:\SQL#Backups'" (Format-EnvValue 'D:\SQL#Backups') '"#" is single-quoted (envconfig.js refuses it unquoted)'
Assert-Equal "``D:\it's#x``" (Format-EnvValue "D:\it's#x") 'a value with a single quote goes in backticks'
Assert-Equal "' x'" (Format-EnvValue ' x') 'outer spaces are kept by quoting'
$threw = $false
try { Format-EnvValue "a'b``#" | Out-Null } catch { $threw = $true }
Assert-True $threw "a value with both ' and a backtick is refused"

$envTmp = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllLines($envTmp, @('SQL_HOST=localhost', 'SQL_BACKUP_DIR='))
    foreach ($v in @('D:\SQL#Backups', 'C:\Program Files\Backup', "D:\it's#x", 'plain')) {
        Set-EnvValue $envTmp 'SQL_BACKUP_DIR' $v
        Assert-Equal $v (Get-EnvValue $envTmp 'SQL_BACKUP_DIR') "Set-EnvValue then Get-EnvValue round-trips '$v'"
    }
    Assert-Equal 'localhost' (Get-EnvValue $envTmp 'SQL_HOST') 'other keys are untouched'
} finally {
    Remove-Item -LiteralPath $envTmp -ErrorAction SilentlyContinue
}

# ---- Test-ZipHash (reuse of a cached zip) ----
$zipTmp = [IO.Path]::GetTempFileName()
$shaTmp = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($zipTmp, 'zip-bytes')
    $hex = (Get-FileHash -Algorithm SHA256 -Path $zipTmp).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($shaTmp, "$($hex.ToUpperInvariant())  backup-manager-1.2.0-win-x64.zip`n")
    Assert-True (Test-ZipHash $zipTmp $shaTmp) 'matching hash (any case, with file name) is accepted'
    [IO.File]::WriteAllText($zipTmp, 'zip-byte')
    Assert-True (-not (Test-ZipHash $zipTmp $shaTmp)) 'a truncated zip is rejected'
    [IO.File]::WriteAllText($shaTmp, '')
    Assert-True (-not (Test-ZipHash $zipTmp $shaTmp)) 'an empty .sha256 is rejected'
} finally {
    Remove-Item -LiteralPath $zipTmp, $shaTmp -ErrorAction SilentlyContinue
}

# ---- Get-SqlAdminSignInOrder ----
Assert-Equal 'env windows prompt' ((Get-SqlAdminSignInOrder 'backup_user' 'pw') -join ' ') 'SQL_USER and SQL_PASSWORD set: try them first'
Assert-Equal 'windows prompt' ((Get-SqlAdminSignInOrder '' '') -join ' ') 'nothing set: Windows, then the sa prompt'
Assert-Equal 'windows prompt' ((Get-SqlAdminSignInOrder 'backup_user' '') -join ' ') 'SQL_USER without a password is not tried'
Assert-Equal 'windows prompt' ((Get-SqlAdminSignInOrder '' 'pw') -join ' ') 'a password without SQL_USER is not tried'

# ---- Connect-SqlAdminLogin cannot be skipped ----
$adminFn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Connect-SqlAdminLogin' }, $true)
Assert-True ($adminFn -and $adminFn.Extent.Text -cnotmatch '\bSKIP\b') 'the sa prompt has no SKIP'
Assert-True ($adminFn -and $adminFn.Extent.Text -notmatch '\bthrow\b') 'the sa prompt keeps asking instead of giving up'

# ---- Get-QuickEditMode ----
Assert-Equal ([uint32]0x1E7) (Get-QuickEditMode ([uint32]0x1A7) $true) 'QuickEdit on: 0x40 and 0x80 set'
Assert-Equal ([uint32]0x1A7) (Get-QuickEditMode ([uint32]0x1E7) $false) 'QuickEdit off: 0x40 cleared, 0x80 kept'
Assert-Equal ([uint32]0x87) (Get-QuickEditMode ([uint32]0x07) $false) 'QuickEdit off sets ENABLE_EXTENDED_FLAGS'
Assert-Equal ([uint32]0x7) ((Get-QuickEditMode ([uint32]0x47) $true) -band [uint32]0x7) 'other mode bits are kept'

# ---- ConvertTo-SqlInstanceName / Format-SqlInstanceNames ----
Assert-Equal '' (ConvertTo-SqlInstanceName 'MSSQLSERVER') 'default instance is the empty SQL_INSTANCE'
Assert-Equal 'SQLEXPRESS' (ConvertTo-SqlInstanceName 'MSSQL$SQLEXPRESS') 'named instance is the part after MSSQL$'
Assert-Equal '(empty) = default instance, SQLEXPRESS' (Format-SqlInstanceNames @('', 'SQLEXPRESS')) 'instance list shows the SQL_INSTANCE values'
Assert-Equal 'none' (Format-SqlInstanceNames @()) 'no instances'
Assert-Equal '(empty) = default instance' (Format-SqlInstanceNames @('')) 'only the default instance is not "none"'

# ---- Security invariant: T-SQL is constant text, values only as parameters ----
# Every -Sql argument of Invoke-SqlAdmin is a $Sql* variable, and every $Sql* variable is assigned
# exactly once, at the top level, from a single-quoted string (no interpolation, no concatenation).
$calls = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Invoke-SqlAdmin' }, $true)
Assert-True ($calls.Count -ge 8) "found the Invoke-SqlAdmin calls ($($calls.Count))"
$sqlVars = @{}
foreach ($call in $calls) {
    $els = $call.CommandElements
    for ($k = 0; $k -lt $els.Count; $k++) {
        if ($els[$k] -is [System.Management.Automation.Language.CommandParameterAst] -and $els[$k].ParameterName -eq 'Sql') {
            $arg = $els[$k + 1]
            $ok = $arg -is [System.Management.Automation.Language.VariableExpressionAst] -and $arg.VariablePath.UserPath -like 'Sql*'
            Assert-True $ok "line $($call.Extent.StartLineNumber): -Sql must be a `$Sql* constant, got: $($arg.Extent.Text)"
            if ($ok) { $sqlVars[$arg.VariablePath.UserPath] = $true }
        }
    }
}
# The inner per-database script is passed as a parameter value; it is a constant too.
$sqlVars['SqlUserGrantsInner'] = $true
$assignments = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)
foreach ($name in $sqlVars.Keys) {
    $mine = @($assignments | Where-Object { $_.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $_.Left.VariablePath.UserPath -eq $name })
    Assert-Equal 1 $mine.Count "`$$name is assigned exactly once"
    if ($mine.Count -ne 1) { continue }
    $rhs = $mine[0].Right
    $expr = if ($rhs -is [System.Management.Automation.Language.CommandExpressionAst]) { $rhs.Expression } else { $null }
    $constant = $expr -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
        ($expr.StringConstantType -eq 'SingleQuoted' -or $expr.StringConstantType -eq 'SingleQuotedHereString')
    Assert-True $constant "`$$name must be a single-quoted constant string"
    Assert-True ($mine[0].Parent.Parent -eq $ast) "`$$name must be defined at the top level of install.ps1"
}

Write-Host ''
if ($script:Failures) {
    Write-Host "$($script:Failures) of $($script:Count) assertions failed." -ForegroundColor Red
    exit 1
}
Write-Host "All $($script:Count) assertions passed." -ForegroundColor Green
