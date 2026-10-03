import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  EyeIcon,
  DocumentDuplicateIcon,
  Cog6ToothIcon,
  PaperClipIcon
} from '@heroicons/react/24/outline';
import { useAuth } from '../../contexts/AuthContext';
import { useShopId } from '../../contexts/ShopContext';
import { loadPage, savePage, ATTACHMENTS_ENABLED } from './adminPageEditData';
import PageAttachments from './PageAttachments';
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
        const pageData = await loadPage(id);
        if (pageData) {
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
      const pageId = await savePage({ id, isNewPage, formData, newStatus, currentUser, shopId });

      if (isNewPage) {
        toast.success('Sidan har skapats');
        setHasBeenSaved(true); // Mark as saved after first save
        navigate(`/admin/pages/${pageId}`);
      } else {
        toast.success('Sidan har uppdaterats');
        setFormData(prev => ({ ...prev, status: newStatus }));
      }
    } catch (error) {
      console.error('Error saving page:', error);
      toast.error(error?.userMessage || 'Fel vid sparande av sida');
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = () => handleSave('published');
  const handleSaveDraft = () => handleSave('draft');

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
  ].filter((tab) => tab.id !== 'attachments' || ATTACHMENTS_ENABLED);

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

        {ATTACHMENTS_ENABLED && activeTab === 'attachments' && (
          <PageAttachments
            id={id}
            isNewPage={isNewPage}
            formData={formData}
            setFormData={setFormData}
            currentUser={currentUser}
            shopId={shopId}
          />
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
