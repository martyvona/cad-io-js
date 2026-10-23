// The PDF style for our Markdown documents, compiled by scripts/md2pdf.sh with Typst. The Markdown is rendered by
// cmarker (CommonMark, GitHub-style heading anchors), its LaTeX math by mitex, its ```mermaid blocks by merman: no
// pandoc, LaTeX or browser (CLAUDE.md, "Decisions"). The document's `#` heading is its title and `##` headings its
// numbered sections. The PDF-only and Markdown-only parts are cmarker's comments:
//   <!--raw-typst ...-->  Typst code, run only here (the title page's #outline() and #pagebreak());
//   <!--typst-begin-exclude--> ... <!--typst-end-exclude-->  left out here (the Markdown's short contents list).
// Input: `md`, the document's path from the repository root, starting with '/'.

#import "@preview/cmarker:0.1.10"
#import "@preview/mitex:0.2.7": mitex
#import "@preview/merman:0.5.0": mermaid

#let md = sys.inputs.at("md")
#let dir = md.split("/").slice(0, -1).join("/") + "/"

#set page(paper: "us-letter", margin: 0.75in, numbering: "1")
#set text(font: "Libertinus Serif", size: 10.5pt)
#set par(justify: true)
#set heading(numbering: "1.1")
#show title: set align(center)
#show outline.entry.where(level: 1): set block(above: 1em)
// Code lines up to 120 characters fit the text width (DejaVu Sans Mono's advance is 0.602 em).
#show raw: set text(font: "DejaVu Sans Mono")
#show raw.where(block: true): set text(size: 6.9pt)
// Long identifiers (SNAKE_CASE entity names in table cells) may break after an underscore.
#show raw.where(block: false): it => { show "_": "_" + sym.zws; it }
#show table: set text(size: 9.5pt)
#show table: set par(justify: false)
// Code blocks shaded; ```mermaid blocks drawn as diagrams, at their natural size scaled down to the text width and
// at most 14 cm tall, labelled in the document's font (merman measures text with fixed estimates, not the font).
#let diagram(source, ..args) = mermaid(source, typography: (font: ("Libertinus Serif",), size: 10.5pt), ..args)
#show raw.where(block: true): it => if it.lang == "mermaid" {
  layout(size => {
    let natural = measure(diagram(it.text))
    let k = calc.min(1, size.width / natural.width, 14cm / natural.height)
    align(center, diagram(it.text, width: natural.width * k))
  })
} else {
  block(fill: luma(245), inset: 6pt, radius: 2pt, width: 100%, it)
}

#cmarker.render(read(md), math: mitex, h1-level: 0,
  scope: (image: (path, ..args) => image(if path.starts-with("/") { path } else { dir + path }, ..args)))
