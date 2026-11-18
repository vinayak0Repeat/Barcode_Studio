Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$settings = [System.Xml.XmlReaderSettings]::new()
$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
$settings.XmlResolver = $null
$settings.ConformanceLevel = [System.Xml.ConformanceLevel]::Document
$allowedAttributes = @(
    'cx', 'cy', 'd', 'fill', 'height', 'id', 'offset', 'r', 'rx',
    'stop-color', 'stop-opacity', 'stroke', 'stroke-linecap', 'stroke-width',
    'viewBox', 'width', 'x', 'x1', 'x2', 'y', 'y1', 'y2'
)

$failed = $false
$files = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.svg' -File
if ($files.Count -eq 0) {
    Write-Error 'No SVG files were found.'
    exit 1
}

foreach ($file in $files) {
    $reader = $null
    try {
        $reader = [System.Xml.XmlReader]::Create($file.FullName, $settings)
        $document = [System.Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
        $root = $document.DocumentElement

        if ($null -eq $root -or $root.LocalName -ne 'svg') {
            throw 'Document root is not <svg>.'
        }
        if ($root.NamespaceURI -ne 'http://www.w3.org/2000/svg') {
            throw 'SVG root is missing the standard SVG namespace.'
        }
        foreach ($element in $document.SelectNodes('//*')) {
            if ($element.NamespaceURI -ne 'http://www.w3.org/2000/svg') {
                throw "Element <$($element.LocalName)> is outside the SVG namespace."
            }
            foreach ($attribute in $element.Attributes) {
                if ($attribute.NamespaceURI -eq 'http://www.w3.org/2000/xmlns/') { continue }
                if ($attribute.NamespaceURI -ne '' -or $attribute.LocalName -notin $allowedAttributes) {
                    throw "Unsupported or invalid attribute '$($attribute.Name)' on <$($element.LocalName)> ."
                }
            }
        }
        if ($document.SelectNodes('//comment()').Count -gt 0) {
            throw 'SVG contains an XML comment.'
        }
        if ($file.Name -match '^concept-[abc]\.svg$' -and $root.GetAttribute('viewBox') -ne '0 0 1200 1200') {
            throw 'Concept viewBox must be exactly 0 0 1200 1200.'
        }

        Write-Host "PASS: $($file.Name)"
    }
    catch {
        Write-Host "FAIL: $($file.Name) - $($_.Exception.Message)" -ForegroundColor Red
        $failed = $true
    }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
    }
}

if ($failed) { exit 1 }
exit 0
