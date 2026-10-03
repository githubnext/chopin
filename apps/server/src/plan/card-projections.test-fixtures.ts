export function questionnaire(id: string, question: string, option: string, header: string) {
	return {
		id,
		questions: [{
			id: question,
			header,
			prompt: `What should ${header} be?`,
			multiple: false,
			options: [{ id: option, label: "Choose this" }],
		}],
	};
}
