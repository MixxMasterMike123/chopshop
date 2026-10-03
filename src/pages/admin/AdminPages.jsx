import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TrashIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { subscribeToPages, deleteShopPage } from './adminPagesData';
import { useStorefrontLinks } from './storefrontLinks';
import { useAuth } from '../../contexts/AuthContext';
import { useShopId } from '../../contexts/ShopContext';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import AppLayout from '../../components/layout/AppLayout';
import { toast } from 'react-hot-toast';
import {
  Page,
  MetricsBar,
  DataTable,
  ViewTabs,
  InlineSearch,
  Button,
  StatusPill,
} from '../../components/admin/ui';

const AdminPages = () => {
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const shopId = useShopId();
  const storefrontLinks = useStorefrontLinks();
  const { getContentValue } = useContentTranslation();
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    if (!currentUser) {
      return; // Keep loading until user is available
    }

    return subscribeToPages(
      shopId,
      (pagesData) => {
        setPages(pagesData);
        setLoading(false);
      },
      () => {
        toast.error('Fel vid hämtning av sidor');
        setLoading(false);
      }
    );
  }, [currentUser, shopId]);

  const handleDelete = async (pageId, pageTitle) => {
    if (!window.confirm(`Är du säker på att du vill ta bort sidan "${getContentValue(pageTitle)}"?`)) {
      return;
    }

    try {
      await deleteShopPage(pageId);
      toast.success('Sidan har tagits bort');
    } catch (error) {
      console.error('Error deleting page:', error);
      toast.error('Fel vid borttagning av sida');
    }
  };

  const filteredPages = pages.filter(page => {
    const matchesSearch = !searchTerm ||
      getContentValue(page.title)?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      page.slug?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'all' ||
      (statusFilter === 'published' && page.status === 'published') ||
      (statusFilter === 'draft' && page.status === 'draft');

    return matchesSearch && matchesStatus;
  });

  const getTranslationStatus = (page) => {
    const languages = ['sv-SE', 'en-GB', 'en-US'];
    const fields = ['title', 'content', 'metaTitle', 'metaDescription'];

    let completedLanguages = 0;

    // Check each language
    for (const lang of languages) {
      let langComplete = true;

      // Check each field for this language
      for (const field of fields) {
        const fieldValue = page[field];

        if (typeof fieldValue === 'string') {
          // Single string value - only counts for Swedish
          if (lang === 'sv-SE' && fieldValue.length === 0) {
            langComplete = false;
            break;
          }
        } else if (typeof fieldValue === 'object' && fieldValue) {
          // Multilingual object
          if (!fieldValue[lang] || fieldValue[lang].length === 0) {
            langComplete = false;
            break;
          }
        } else {
          // No value at all
          langComplete = false;
          break;
        }
      }

      if (langComplete) {
        completedLanguages++;
      }
    }

    // Tone mapping mirrors the previous dot colors:
    // 3/3 → success (green), 2/3 → info (blue), 1/3 → warning (yellow), 0 → neutral.
    const tone =
      completedLanguages === 3 ? 'success' :
      completedLanguages >= 2 ? 'info' :
      completedLanguages >= 1 ? 'warning' :
      'neutral';

    return {
      completed: completedLanguages,
      total: languages.length,
      tone,
    };
  };

  // Thin metrics strip (replaces the old big-number stats card). All derived from
  // already-loaded data — no extra queries.
  const metrics = [
    { key: 'total', label: 'Totalt antal sidor', value: pages.length },
    { key: 'published', label: 'Publicerade sidor', value: pages.filter(p => p.status === 'published').length },
    { key: 'draft', label: 'Utkast', value: pages.filter(p => p.status === 'draft').length },
  ];

  // Status filter as view-tabs (replaces the old <select>). Same filter values.
  const statusTabOptions = [
    { value: 'all', label: 'Alla statusar' },
    { value: 'published', label: 'Publicerad' },
    { value: 'draft', label: 'Utkast' },
  ];

  const columns = [
    {
      key: 'title',
      header: 'Titel',
      render: (page) => (
        <span className="min-w-0">
          <span className="block truncate font-medium text-admin-text group-hover:underline">
            {getContentValue(page.title) || 'Utan titel'}
          </span>
          {page.metaTitle && (
            <span className="block truncate text-[12px] text-admin-text-faint">
              SEO: {getContentValue(page.metaTitle)}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'slug',
      header: 'Slug',
      render: (page) => (
        <span className="font-mono text-admin-text-muted">/{page.slug}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (page) =>
        page.status === 'published' ? (
          <StatusPill tone="success">Publicerad</StatusPill>
        ) : (
          <StatusPill tone="warning">Utkast</StatusPill>
        ),
    },
    {
      key: 'translations',
      header: 'Översättningar',
      render: (page) => {
        const t = getTranslationStatus(page);
        return (
          <span title={`${t.completed}/${t.total} språk kompletta`}>
            <StatusPill tone={t.tone}>
              {t.completed}/{t.total}
            </StatusPill>
          </span>
        );
      },
    },
    {
      key: 'updated',
      header: 'Uppdaterad',
      render: (page) => (
        <span className="text-admin-text-muted whitespace-nowrap">
          {page.updatedAt?.toDate?.()?.toLocaleDateString('sv-SE') || 'Okänt'}
        </span>
      ),
    },
    {
      // Trailing actions: view (published only) + delete. Stop row click so they
      // don't open the editor.
      key: 'actions',
      header: '',
      align: 'right',
      className: 'w-20',
      render: (page) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {page.status === 'published' && (
            <a
              {...storefrontLinks.page(page.slug)}
              target="_blank"
              rel="noopener noreferrer"
              title="Visa sida"
              aria-label="Visa sida"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-text"
            >
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </a>
          )}
          <button
            type="button"
            onClick={() => handleDelete(page.id, page.title)}
            title="Ta bort sida"
            aria-label="Ta bort sida"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-critical-dot"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  const tableToolbar = (
    <>
      <ViewTabs
        ariaLabel="Filtrera på status"
        options={statusTabOptions}
        value={statusFilter}
        onChange={setStatusFilter}
      />
      <InlineSearch
        value={searchTerm}
        onChange={setSearchTerm}
        placeholder="Sök efter titel eller slug…"
      />
    </>
  );

  return (
    <AppLayout>
      <Page
        title="Sidhantering"
        subtitle="Hantera webbsidornas innehåll och struktur"
        actions={
          <Button variant="primary" as={Link} to="/admin/pages/new">
            Ny sida
          </Button>
        }
      >
        <div className="space-y-3">
          <MetricsBar metrics={metrics} />

          <DataTable
            columns={columns}
            rows={filteredPages}
            rowKey={(p) => p.id}
            loading={loading || !currentUser}
            onRowClick={(p) => navigate(`/admin/pages/${p.id}`)}
            empty={
              searchTerm || statusFilter !== 'all'
                ? 'Inga sidor matchar dina filter.'
                : 'Kom igång genom att skapa din första sida.'
            }
            toolbar={tableToolbar}
          />
        </div>
      </Page>
    </AppLayout>
  );
};

export default AdminPages;
