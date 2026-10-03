// The Studio tab of PodAdminPage in the ADMIN build (CP5 unit FM): the alias
// list of vite.admin.config.js puts this module in place of
// src/wagons/pod-wagon/components/podStudio.js, which re-exports the design
// studio. The studio is not in this build yet (its unit is FN, CP6: mockup
// templates and 3D models have no route yet), so the tab says so plainly
// and points at what works: the library and the mapping tab.

import React from 'react';
import { CardSection } from '../../components/admin/ui';

/** "Fortsätt till Designstudion" is not offered: there is no studio to go to. */
export const STUDIO_AVAILABLE = false;

export function DesignStudio() {
  return (
    <CardSection title="Designstudion">
      <p className="text-[13px] text-admin-text-muted">
        Designstudion kommer snart i den nya adminen. Till dess laddar du upp tryckfiler under{' '}
        <span className="font-medium text-admin-text">Original</span> och kopplar dem till produkter under{' '}
        <span className="font-medium text-admin-text">Avancerat</span>, där du väljer tryckeri, artikel och placering.
      </p>
    </CardSection>
  );
}

export default DesignStudio;
