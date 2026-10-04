// LazyPart.jsx — a Suspense with a floor under it, for the studio's parts that
// load their code on demand (the Pixi engine behind the 3D view and the
// garment photo's fine-tuning).
//
// A chunk can fail to load: after a new version of the admin is deployed, the
// files of the version an open tab was built from are gone (404). React.lazy
// then throws while rendering, and with nothing to catch it the whole admin
// goes blank and the seller loses the design. This catches it and says what
// to do, in the part's own place; the rest of the studio stays as it was.
import React, { Suspense } from 'react';

class LazyPart extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.warn('Studio: a part could not be loaded', error?.message);
  }

  render() {
    if (this.state.failed) {
      return (
        <p role="alert" className="rounded-[var(--radius-admin-el)] bg-admin-surface-2 px-3 py-2 text-[12px] text-admin-caution-text">
          Den här delen kunde inte laddas, troligen för att sidan har uppdaterats sedan du öppnade den. Ladda om sidan för att använda den.
        </p>
      );
    }
    return <Suspense fallback={this.props.fallback ?? null}>{this.props.children}</Suspense>;
  }
}

export default LazyPart;
