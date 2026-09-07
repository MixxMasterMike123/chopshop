import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  EyeIcon,
  DocumentDuplicateIcon,
  Cog6ToothIcon,
  PaperClipIcon
} from '@heroicons/react/24/outline';
import { doc, getDoc, setDoc, serverTimestamp, addDoc, collection } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { useAuth } from '../../contexts/AuthContext';
import { useShopId } from '../../contexts/ShopContext';
import { withShopId } from '../../config/withShopId';
import { saveShopConfig } from '../../config/shopConfig';
import {
  isLegalSlug,
  LEGAL_PAGES,
  LEGAL_PAGE_KEYS,
  LEGAL_REQUIRED_SECTIONS,
  LEGAL_TEMPLATE_DISCLAIMER,
} from '../../config/legalTemplates';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import ContentLanguageIndicator from '../../components/ContentLanguageIndicator';
import AppLayout from '../../components/layout/AppLayout';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { toast } from 'react-hot-toast';
import FileUpload from '../../components/admin/FileUpload';
import FileManager from '../../components/admin/FileManager';
import { uploadFile, deleteFile } from '../../utils/fileUpload';
import { Page, Card, CardSection, RightRail, Button, StatusPill } from '../../components/admin/ui';

// ReactQuill configuration
const quillModules = {
  toolbar: [
    [{ 'header': [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
    [{ 'color': [] }, { 'background': [] }],
    [{ 'align': [] }],
    ['link', 'image'],
    ['clean']
  ],
};

const quillFormats = [
  'header',
  'bold', 'italic', 'underline', 'strike',
  'list', 'bullet',
  'color', 'background',
  'align',
  'link', 'image'
];

const AdminPageEdit = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const shopId = useShopId();
  const { getContentValue, setContentValue } = useContentTranslation();



  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('content');
  const [formData, setFormData] = useState({
    title: '',
    slug: '',
    content: '',
    status: 'draft',
    metaTitle: '',
    metaDescription: '',
    attachments: [],
    createdAt: null,
    updatedAt: null,
    createdBy: '',
    updatedBy: ''
  });

  const isNewPage = id === 'new';
  const [hasBeenSaved, setHasBeenSaved] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);

  // Update formData when user becomes available
  useEffect(() => {
    if (currentUser && isNewPage) {
      setFormData(prev => ({
        ...prev,
        createdBy: currentUser.uid,
        updatedBy: currentUser.uid
      }));
    }
  }, [currentUser, isNewPage]);

  useEffect(() => {
    // Wait for user to be loaded
    if (!currentUser) {
      setLoading(false);
      return;
    }

    if (isNewPage) {
      setLoading(false);
      return;
    }

    const fetchPage = async () => {
      try {
        const pageDoc = await getDoc(doc(db, 'pages', id));
        if (pageDoc.exists()) {
                  const pageData = pageDoc.data();
        setFormData(prev => ({
          ...prev,
          ...pageData,
          createdBy: pageData.createdBy || currentUser.uid,
          updatedBy: pageData.updatedBy || currentUser.uid
        }));
        // Mark as saved since this is an existing page
        setHasBeenSaved(true);
        } else {
          toast.error('Sidan kunde inte hittas');
          navigate('/admin/pages');
        }
      } catch (error) {
        console.error('Error fetching page:', error);
        toast.error('Fel vid hämtning av sida');
      } finally {
        setLoading(false);
      }
    };

          fetchPage();
  }, [id, isNewPage, currentUser, navigate]);

  const generateSlug = (title) => {
    if (!title) return '';
    return title
      .toLowerCase()
      .replace(/[åä]/g, 'a')
      .replace(/ö/g, 'o')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  };

  // Auto-generate slug from Swedish title when title changes (only for new pages)
  const handleTitleChange = (e) => {
    const newTitle = setContentValue(formData.title, e.target.value);

    setFormData({
      ...formData,
      title: newTitle,
      // Only auto-generate slug if this is a new page that hasn't been saved yet
      slug: (isNewPage && !hasBeenSaved) ? generateSlug(newTitle['sv-SE'] || '') : formData.slug
    });
  };

  const handleSave = async (newStatus = formData.status) => {
    if (!formData.title || !getContentValue(formData.title)) {
      toast.error('Titel är obligatorisk');
      return;
    }

    if (!formData.slug) {
      toast.error('Slug är obligatorisk');
      return;
    }

    setSaving(true);

    try {
      const pageData = {
        ...formData,
        status: newStatus,
        updatedAt: serverTimestamp(),
        updatedBy: currentUser?.uid || '',
        ...(isNewPage && {
          createdAt: serverTimestamp(),
                      createdBy: currentUser?.uid || ''
        })
      };

      // Editing a legal page invalidates the seller's last acceptance — stamp
      // storeIdentity.legal.customUpdatedAt so needsLegalReacceptance() flags it
      // in AdminSettings + on the platform. Never let this fail the page save.
      //
      // Only on a PUBLISHED save: a draft doesn't change what the storefront
      // serves, and stamping on every autosave-to-draft would train the seller
      // to click past a re-acceptance notice that means nothing.
      const stampLegalEdit = async () => {
        if (!isLegalSlug(formData.slug) || newStatus !== 'published') return;
        try {
          await saveShopConfig({ legal: { customUpdatedAt: new Date().toISOString() } }, shopId);
        } catch (e) {
          console.error('Could not stamp legal.customUpdatedAt:', e);
        }
      };

      if (isNewPage) {
        // For new pages, use addDoc to generate a unique ID
        const docRef = await addDoc(collection(db, 'pages'), withShopId(pageData, shopId));
        const pageId = docRef.id;
        await stampLegalEdit();

        toast.success('Sidan har skapats');
        setHasBeenSaved(true); // Mark as saved after first save
        navigate(`/admin/pages/${pageId}`);
      } else {
        // For existing pages, use setDoc with the existing ID. This is a FULL
        // overwrite (not merge), so we must re-stamp shopId or it would be
        // stripped from an already-tagged doc.
        await setDoc(doc(db, 'pages', id), withShopId(pageData, shopId));
        await stampLegalEdit();

        toast.success('Sidan har uppdaterats');
        setFormData(prev => ({ ...prev, status: newStatus }));
      }
    } catch (error) {
      console.error('Error saving page:', error);
      toast.error('Fel vid sparande av sida');
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = () => handleSave('published');
  const handleSaveDraft = () => handleSave('draft');

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

  // ── Legal slug awareness ────────────────────────────────────────────────
  // A page on one of the three legal slugs REPLACES the platform template on the
  // storefront (copy-on-write, started from AdminSettings). The slug is locked
  // (changing it would silently orphan the shop's legal page) and the required
  // sections are checked as a SOFT warning — the text is the seller's, so we
  // never block a save, we just say what looks missing.
  const isLegalPage = isLegalSlug(formData.slug);
  const legalTitle = isLegalPage ? LEGAL_PAGES[formData.slug].title : '';

  const missingLegalSections = React.useMemo(() => {
    if (!isLegalPage) return [];
    const required = LEGAL_REQUIRED_SECTIONS[LEGAL_PAGE_KEYS[formData.slug]] || [];
    // Plain text of the Swedish content — the legal text is Swedish, and the
    // section names we look for are Swedish.
    const raw = typeof formData.content === 'string'
      ? formData.content
      : (formData.content?.['sv-SE'] || '');
    const plain = String(raw).replace(/<[^>]*>/g, ' ').toLowerCase();
    return required.filter((section) => !plain.includes(section.toLowerCase()));
  }, [isLegalPage, formData.slug, formData.content]);

  const tabs = [
    { id: 'content', name: 'Innehåll', icon: DocumentDuplicateIcon },
    { id: 'attachments', name: 'Bilagor', icon: PaperClipIcon },
    { id: 'seo', name: 'SEO', icon: Cog6ToothIcon }
  ];

  const labelCls = 'block text-[13px] font-medium text-admin-text mb-1';
  const inputCls =
    'w-full rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]';
  const helpCls = 'mt-1 text-[12px] text-admin-text-muted';

  const headerActions = (
    <>
      {!isNewPage && formData.status === 'published' && (
        <Button as="a" href={`/${formData.slug}`} target="_blank" rel="noopener noreferrer" variant="secondary">
          <EyeIcon className="h-4 w-4" />
          Visa sida
        </Button>
      )}
      <Button variant="secondary" onClick={handleSaveDraft} disabled={saving}>
        Spara utkast
      </Button>
      <Button variant="primary" onClick={handlePublish} disabled={saving}>
        {formData.status === 'published' ? 'Uppdatera' : 'Publicera'}
      </Button>
    </>
  );

  if (loading) {
    return (
      <AppLayout>
        <Page title="Sida" back={{ to: '/admin/pages', label: 'Tillbaka till sidor' }}>
          <Card className="px-6 py-12 text-center">
            <div className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-solid border-admin-text-muted border-r-transparent" />
            <p className="mt-3 text-[13px] text-admin-text-muted">Laddar sida…</p>
          </Card>
        </Page>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <Page
        title={isNewPage ? 'Ny sida' : getContentValue(formData.title) || 'Redigera sida'}
        subtitle={!isNewPage ? `Slug: /${formData.slug}` : undefined}
        titleAdornment={
          !isNewPage ? (
            <StatusPill tone={formData.status === 'published' ? 'success' : 'neutral'}>
              {formData.status === 'published' ? 'Publicerad' : 'Utkast'}
            </StatusPill>
          ) : undefined
        }
        back={{ to: '/admin/pages', label: 'Tillbaka till sidor' }}
        actions={headerActions}
      >
        {/* Tabs */}
        <div className="mb-5 border-b border-admin-border">
          <nav className="-mb-px flex gap-6">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 border-b-2 px-1 py-2 text-[13px] font-medium ${
                    activeTab === tab.id
                      ? 'border-[var(--color-admin-primary)] text-admin-text'
                      : 'border-transparent text-admin-text-muted hover:border-admin-border hover:text-admin-text'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {tab.name}
                </button>
              );
            })}
          </nav>
        </div>

        {activeTab === 'content' && (
          <RightRail
            main={
              <>
                {isLegalPage && (
                  <div className="mb-4 rounded-[var(--radius-admin-el)] border border-admin-caution-dot bg-admin-caution-bg px-3 py-2 text-[12px] text-admin-caution-text">
                    <p>{LEGAL_TEMPLATE_DISCLAIMER}</p>
                    <p className="mt-2 font-medium">
                      Den här sidan ersätter plattformens mall för {legalTitle}. Du ansvarar för
                      innehållet. När du sparar måste du godkänna villkoren på nytt under Inställningar.
                    </p>
                    {missingLegalSections.length > 0 && (
                      <div className="mt-2">
                        <p className="font-medium">Följande avsnitt verkar saknas:</p>
                        <ul className="mt-1 list-disc pl-5">
                          {missingLegalSections.map((section) => (
                            <li key={section}>{section}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                <CardSection title="Innehåll" bodyClassName="space-y-4">
                  {/* Title */}
                  <div>
                    <label htmlFor="title" className={labelCls}>
                      Titel *
                    </label>
                    <ContentLanguageIndicator
                      contentField={formData.title}
                      label="Titel"
                      currentValue={getContentValue(formData.title)}
                    />
                    <input
                      type="text"
                      id="title"
                      value={getContentValue(formData.title)}
                      onChange={handleTitleChange}
                      className={inputCls}
                      placeholder="Sidans titel..."
                      required
                    />
                  </div>

                  {/* Slug */}
                  <div>
                    <label htmlFor="slug" className={labelCls}>
                      Slug *
                    </label>
                    <div className="flex">
                      <span className="inline-flex items-center rounded-l-[var(--radius-admin-el)] border border-r-0 border-admin-border bg-admin-surface-2 px-3 text-[13px] text-admin-text-muted">
                        /
                      </span>
                      <input
                        type="text"
                        id="slug"
                        value={formData.slug}
                        onChange={(e) => setFormData(prev => ({ ...prev, slug: e.target.value }))}
                        readOnly={isLegalPage}
                        className={`w-full flex-1 rounded-r-[var(--radius-admin-el)] border border-admin-border px-3 py-1.5 text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)] ${isLegalPage ? 'bg-admin-surface-2 text-admin-text-muted' : 'bg-admin-surface'}`}
                        placeholder="sida-slug"
                      />
                    </div>
                    <p className={helpCls}>
                      {isLegalPage ? (
                        <>Låst: juridisk sida.</>
                      ) : isNewPage && !hasBeenSaved ? (
                        <>
                          URL-vänlig version av sidtiteln. <span className="font-medium text-admin-text">Genereras automatiskt från svenska titeln.</span> Endast små bokstäver, siffror och bindestreck.
                        </>
                      ) : (
                        <>
                          URL-vänlig version av sidtiteln. <span className="font-medium text-admin-text">Manuell redigering möjlig.</span> Endast små bokstäver, siffror och bindestreck.
                        </>
                      )}
                    </p>
                  </div>

                  {/* Content */}
                  <div>
                    <label htmlFor="content" className={labelCls}>
                      Innehåll
                    </label>
                    <ContentLanguageIndicator
                      contentField={formData.content}
                      label="Innehåll"
                      currentValue={getContentValue(formData.content)}
                    />
                    <div className="overflow-hidden rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface">
                      <div className="quill-dark-mode">
                        <ReactQuill
                          theme="snow"
                          value={getContentValue(formData.content)}
                          onChange={(value) => setFormData({
                            ...formData,
                            content: setContentValue(formData.content, value)
                          })}
                          modules={quillModules}
                          formats={quillFormats}
                          placeholder="Sidans innehåll..."
                        />
                      </div>
                    </div>
                  </div>
                </CardSection>
              </>
            }
            rail={
              <>
                <CardSection title="Status" bodyClassName="space-y-3">
                  <div className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-admin-text-muted">Publiceringsstatus</span>
                    <StatusPill tone={formData.status === 'published' ? 'success' : 'neutral'}>
                      {formData.status === 'published' ? 'Publicerad' : 'Utkast'}
                    </StatusPill>
                  </div>
                  <div className="flex flex-col gap-2 pt-1">
                    <Button variant="secondary" onClick={handleSaveDraft} disabled={saving} className="w-full">
                      Spara utkast
                    </Button>
                    <Button variant="primary" onClick={handlePublish} disabled={saving} className="w-full">
                      {formData.status === 'published' ? 'Uppdatera' : 'Publicera'}
                    </Button>
                  </div>
                  {saving && <p className={helpCls}>Sparar sida…</p>}
                </CardSection>
              </>
            }
          />
        )}

        {activeTab === 'attachments' && (
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
        )}

        {activeTab === 'seo' && (
          <RightRail
            main={
              <CardSection title="SEO" bodyClassName="space-y-4">
                {/* Meta Title */}
                <div>
                  <label htmlFor="metaTitle" className={labelCls}>
                    SEO Titel
                  </label>
                  <ContentLanguageIndicator
                    contentField={formData.metaTitle}
                    label="SEO Titel"
                    currentValue={getContentValue(formData.metaTitle)}
                  />
                  <input
                    type="text"
                    id="metaTitle"
                    value={getContentValue(formData.metaTitle)}
                    onChange={(e) => setFormData({
                      ...formData,
                      metaTitle: setContentValue(formData.metaTitle, e.target.value)
                    })}
                    className={inputCls}
                    placeholder="SEO-optimerad titel för sökmotorer..."
                    maxLength="60"
                  />
                  <p className={helpCls}>
                    {getContentValue(formData.metaTitle).length}/60 tecken
                  </p>
                </div>

                {/* Meta Description */}
                <div>
                  <label htmlFor="metaDescription" className={labelCls}>
                    SEO Beskrivning
                  </label>
                  <ContentLanguageIndicator
                    contentField={formData.metaDescription}
                    label="SEO Beskrivning"
                    currentValue={getContentValue(formData.metaDescription)}
                  />
                  <textarea
                    id="metaDescription"
                    rows="3"
                    value={getContentValue(formData.metaDescription)}
                    onChange={(e) => setFormData({
                      ...formData,
                      metaDescription: setContentValue(formData.metaDescription, e.target.value)
                    })}
                    className={inputCls}
                    placeholder="Kort beskrivning av sidan för sökmotorer..."
                    maxLength="160"
                  />
                  <p className={helpCls}>
                    {getContentValue(formData.metaDescription).length}/160 tecken
                  </p>
                </div>
              </CardSection>
            }
            rail={
              <Card className="bg-admin-info-bg p-4">
                <h4 className="mb-2 text-[13px] font-semibold text-admin-info-text">SEO Tips:</h4>
                <ul className="space-y-1 text-[13px] text-admin-info-text">
                  <li>• Använd relevanta nyckelord i titel och beskrivning</li>
                  <li>• Håll titeln under 60 tecken och beskrivningen under 160 tecken</li>
                  <li>• Gör titeln och beskrivningen unika för varje sida</li>
                  <li>• Skriv för människor, inte bara sökmotorer</li>
                </ul>
              </Card>
            }
          />
        )}
      </Page>
    </AppLayout>
  );
};

export default AdminPageEdit;
