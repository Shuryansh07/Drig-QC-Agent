/**
 * How a cited page is named to the technician.
 *
 * page_number is the page's place in the PDF file; page_label is the number
 * printed on the page itself, when it shows one. They often differ: the AD
 * Plus2.0 manual's 16th PDF page is printed "Page 8 of 104". Someone holding
 * the printed manual looks for 8, someone in a PDF viewer types 16, so both are
 * shown when they differ. Only the label is never enough: one file can bundle
 * an English and a French copy that both print "Page 1".
 */
export function pageCaption(pageNumber: number, pageLabel?: string | null): string {
  return pageLabel && pageLabel !== String(pageNumber) ? `Page ${pageLabel} · PDF p. ${pageNumber}` : `Page ${pageNumber}`;
}
