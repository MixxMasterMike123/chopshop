// The attachments tab of AdminPageEdit — the OLDER build's component.
//
// Moved out of AdminPageEdit.jsx with its handlers, unchanged. The admin build
// has no attachments (D94: not built): its alias list swaps this file for
// src/admin-app/replacements/PageAttachments.jsx, which renders nothing, and
// FileUpload, FileManager and the Firebase upload code are not part of it.

import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import FileUpload from '../../components/admin/FileUpload';
import FileManager from '../../components/admin/FileManager';
import { uploadFile, deleteFile } from '../../utils/fileUpload';
import { Card, CardSection, Button } from '../../components/admin/ui';

const PageAttachments = ({ id, isNewPage, formData, setFormData, currentUser, shopId }) => {
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);

  // File handling functions
  const handleFileSelect = (files) => {
    setSelectedFiles(prev => [...prev, ...files]);
  };

  const handleFileRemove = (index) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleUploadFiles = async () => {
    if (selectedFiles.length === 0) return;

    setUploadingFiles(true);
    try {
      const uploadPromises = selectedFiles.map(file =>
        uploadFile(file, isNewPage ? 'temp' : id, currentUser.uid, shopId)
      );

      const uploadedFiles = await Promise.all(uploadPromises);

      setFormData(prev => ({
        ...prev,
        attachments: [...(prev.attachments || []), ...uploadedFiles]
      }));

      setSelectedFiles([]);
      toast.success(`${uploadedFiles.length} filer laddades upp framgångsrikt`);
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Ett fel uppstod vid uppladdning av filer');
    } finally {
      setUploadingFiles(false);
    }
  };

  const handleDeleteFile = async (fileId) => {
    try {
      const fileToDelete = formData.attachments.find(f => f.id === fileId);
      if (fileToDelete && fileToDelete.storagePath) {
        await deleteFile(fileToDelete.storagePath);
      }

      setFormData(prev => ({
        ...prev,
        attachments: prev.attachments.filter(f => f.id !== fileId)
      }));

      toast.success('Filen togs bort');
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Ett fel uppstod vid borttagning av filen');
    }
  };

  const handleToggleFileVisibility = (fileId) => {
    setFormData(prev => ({
      ...prev,
      attachments: prev.attachments.map(f =>
        f.id === fileId ? { ...f, isPublic: !f.isPublic } : f
      )
    }));
  };

  const handleUpdateFileDisplayName = (fileId, newName) => {
    setFormData(prev => ({
      ...prev,
      attachments: prev.attachments.map(f =>
        f.id === fileId ? { ...f, displayName: newName } : f
      )
    }));
  };

  return (
    <div className="space-y-5">
      {/* File Upload Section */}
      <CardSection title="Ladda upp bilagor" bodyClassName="space-y-4">
        <FileUpload
          onFileSelect={handleFileSelect}
          onFileRemove={handleFileRemove}
          selectedFiles={selectedFiles}
          disabled={uploadingFiles}
        />

        {selectedFiles.length > 0 && (
          <div className="flex justify-end">
            <Button variant="primary" onClick={handleUploadFiles} disabled={uploadingFiles}>
              {uploadingFiles ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-b-2 border-current" />
                  Laddar upp...
                </>
              ) : (
                `Ladda upp ${selectedFiles.length} filer`
              )}
            </Button>
          </div>
        )}
      </CardSection>

      {/* File Management Section */}
      <CardSection title="Hantera bilagor">
        <FileManager
          files={formData.attachments || []}
          onDeleteFile={handleDeleteFile}
          onToggleVisibility={handleToggleFileVisibility}
          onUpdateDisplayName={handleUpdateFileDisplayName}
          disabled={uploadingFiles}
        />
      </CardSection>

      {/* Help Section */}
      <Card className="bg-admin-info-bg p-4">
        <h4 className="mb-2 text-[13px] font-semibold text-admin-info-text">Tips för bilagor:</h4>
        <ul className="space-y-1 text-[13px] text-admin-info-text">
          <li>• Endast publika filer visas för besökare på sidan</li>
          <li>• Du kan redigera filnamnet för att göra det mer beskrivande</li>
          <li>• Största filstorlek: 10MB per fil</li>
          <li>• Tillåtna filtyper: PDF, DOC, DOCX, XLS, XLSX, TXT, ZIP</li>
          <li>• Filer sparas automatiskt när du sparar sidan</li>
        </ul>
      </Card>
    </div>
  );
};

export default PageAttachments;
