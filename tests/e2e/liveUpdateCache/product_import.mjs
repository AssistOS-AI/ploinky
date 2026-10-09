// The one dynamic-import site for the candidate product. Its URL is the catalog's entryParentURL, so the recording
// run and the verified worker resolve product specifiers from exactly the same parent.
export async function importProduct(url) {
    return import(url);
}
