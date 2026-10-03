// The attachments tab of AdminPageEdit for the admin build: nothing (D94,
// attachments are not built). The alias list of vite.admin.config.js puts this
// file where the page imports src/pages/admin/PageAttachments.jsx, so
// FileUpload, FileManager and the Firebase upload code are not part of the
// build. The page does not draw the tab either (ATTACHMENTS_ENABLED is false).
const PageAttachments = () => null;

export default PageAttachments;
