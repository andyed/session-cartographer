import { Component } from 'react';

export default class RouteErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`[${this.props.name || 'Explorer'} route]`, error, info);
  }

  componentDidUpdate(previousProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  retry = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    const name = this.props.name || 'This view';
    return (
      <section className="h-full grid place-content-center px-6" role="alert" aria-live="assertive">
        <div className="max-w-xl border border-amber-700/50 bg-amber-950/20 rounded-lg p-6">
          <p className="text-xs font-mono uppercase tracking-wider text-amber-400 mb-2">View interrupted</p>
          <h1 className="text-lg text-gray-100 mb-2">{name} needs a reset</h1>
          <p className="text-sm leading-6 text-gray-300 mb-4">
            Explorer kept the rest of the app running. Retry this view{this.props.onLeave ? ', or return to the timeline' : ''}.
          </p>
          <p className="text-xs font-mono text-muted mb-5 break-words">
            {this.state.error?.message || 'Unexpected rendering error'}
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={this.retry}
              className="min-h-11 px-4 rounded bg-amber-500 text-gray-950 text-sm font-medium hover:bg-amber-400"
            >
              Try again
            </button>
            {this.props.onLeave && (
              <button
                type="button"
                onClick={this.props.onLeave}
                className="min-h-11 px-4 rounded border border-gray-700 text-gray-300 text-sm hover:border-gray-500 hover:text-white"
              >
                Back to timeline
              </button>
            )}
          </div>
        </div>
      </section>
    );
  }
}
