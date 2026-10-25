export function createEventLogger(append, onFailure) {
	let pending = Promise.resolve();
	let firstError;
	return {
		record(entry) {
			pending = pending.then(() => append(entry)).catch((error) => {
				if (firstError === undefined) {
					firstError = error;
					onFailure(error);
				}
			});
			return pending;
		},
		flush() {
			return pending;
		},
		get error() {
			return firstError;
		},
	};
}
