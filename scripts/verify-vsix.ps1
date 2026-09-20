$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$vsixPath = Join-Path $PSScriptRoot '../artifacts/gh-aw-visual-editor-0.1.0.vsix'
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $vsixPath))
try {
    $allowed = @('[Content_Types].xml', 'extension.vsixmanifest', 'extension/LICENSE.txt', 'extension/readme.md', 'extension/README.ja.md', 'extension/THIRD_PARTY_NOTICES.md', 'extension/changelog.md', 'extension/resouces/icon.png', 'extension/sample/README.md', 'extension/sample/doc-consistency.md', 'extension/sample/pr-agentic-repair.md', 'extension/images/doc-consistency.png', 'extension/images/pr-agentic-repair.png', 'extension/package.json', 'extension/package.nls.json', 'extension/package.nls.ja.json', 'extension/dist/extension.js', 'extension/dist/webview.js', 'extension/dist/webview.css', 'extension/docs/compatibility.md', 'extension/docs/limitations.md', 'extension/docs/first-workflow.ja.md')
    $actual = @($archive.Entries | ForEach-Object FullName)
    $difference = Compare-Object ($allowed | Sort-Object) ($actual | Sort-Object)
    if ($difference) { throw ('Unexpected VSIX contents: ' + ($difference | Out-String)) }
    foreach ($asset in @('dist/extension.js', 'dist/webview.js', 'dist/webview.css', 'resouces/icon.png', 'sample/doc-consistency.md', 'sample/pr-agentic-repair.md', 'images/doc-consistency.png', 'images/pr-agentic-repair.png')) {
        $entry = $archive.GetEntry('extension/' + $asset)
        $stream = $entry.Open()
        try {
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $inside = [Convert]::ToHexString($sha.ComputeHash($stream)) } finally { $sha.Dispose() }
        } finally { $stream.Dispose() }
        $outside = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot ('../' + $asset)) -Algorithm SHA256).Hash
        if ($inside -ne $outside) { throw ('Bundled asset differs: ' + $asset) }
    }
    $actual | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot '../artifacts/vsix-contents.json') -Encoding utf8
    $metadata = $archive.GetEntry('extension/package.json').Open()
    try {
        $reader = [IO.StreamReader]::new($metadata)
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    } finally { $metadata.Dispose() }
    if ($manifest.displayName -ne 'Agentic Workflow Designer' -or $manifest.publisher -ne 'htkym' -or $manifest.icon -ne 'resouces/icon.png') {
        throw 'VSIX publisher, extension name, or icon metadata differs.'
    }
    Write-Output ('Verified VSIX: ' + $actual.Count + ' files; bundled asset hashes and metadata match.')
} finally { $archive.Dispose() }
