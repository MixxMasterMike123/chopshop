// src/utils/fileUpload.js for the Cloudflare storefront (alias list,
// vite.storefront.config.js). A content page's attachment list (DynamicPage)
// formats a size and names a type with the two functions below. Pages carry
// no attachments on Cloudflare (D94), so the list never renders; the
// functions are the Firebase module's, unchanged. Left out: the upload and
// delete functions, which are the admin's and use Firebase Storage.

export const ALLOWED_FILE_TYPES = {
  'application/pdf': { icon: 'DocumentIcon', label: 'PDF', color: 'text-red-500' },
  'application/msword': { icon: 'DocumentIcon', label: 'DOC', color: 'text-blue-500' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { icon: 'DocumentIcon', label: 'DOCX', color: 'text-blue-500' },
  'application/vnd.ms-excel': { icon: 'DocumentIcon', label: 'XLS', color: 'text-green-500' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { icon: 'DocumentIcon', label: 'XLSX', color: 'text-green-500' },
  'text/plain': { icon: 'DocumentIcon', label: 'TXT', color: 'text-gray-500' },
  'application/zip': { icon: 'DocumentIcon', label: 'ZIP', color: 'text-purple-500' },
  'application/x-zip-compressed': { icon: 'DocumentIcon', label: 'ZIP', color: 'text-purple-500' }
};

export const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const getFileTypeInfo = (mimeType) => {
  return ALLOWED_FILE_TYPES[mimeType] || {
    icon: 'DocumentIcon',
    label: 'FILE',
    color: 'text-gray-500'
  };
};
