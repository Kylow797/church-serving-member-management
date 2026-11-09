import { Component } from 'react'

// Catches render-time crashes so the page shows a readable fault panel
// instead of an empty #root.
// Props:
//   where     - label for what failed ("Schedule", "Application")
//   resetKey  - when it changes (e.g. pathname) the fault clears, so navigating recovers
//   className - optional wrapper class (used at app level for page gutters)
export default class ErrorBoundary extends Component {
  state = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error) {
    return { error }
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error, info) {
    console.error('[serving] render fault', error, info?.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const message = error?.message || String(error) || 'Something went wrong rendering this page.'
    const detail = error?.stack || message
    const panel = (
      <div className="fault" role="alert">
        <div className="fault-h">
          <span className="stamp signal solid">Fault</span>
          <span className="label">{this.props.where || 'Page'} failed to render</span>
        </div>
        <p className="fault-msg">{message}</p>
        <div className="fault-actions">
          <button type="button" className="btn small" onClick={() => this.setState({ error: null })}>Try again</button>
          <button type="button" className="btn small" onClick={() => window.location.reload()}>Reload page</button>
        </div>
        <details>
          <summary className="label">Technical detail</summary>
          <pre>{detail}</pre>
        </details>
      </div>
    )
    return this.props.className ? <div className={this.props.className}>{panel}</div> : panel
  }
}
